import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Link, useNavigate } from 'react-router';
import {
  Button, Space, Select, Tag, App, Empty, Spin, Checkbox, Dropdown, message,
  Tooltip, Segmented, Input, Badge, Popover, Tabs, Collapse,
} from 'antd';
import {
  LeftOutlined, PlayCircleOutlined, PauseOutlined, StepBackwardFilled, StepForwardFilled,
  LinkOutlined, ExportOutlined, SendOutlined, DeleteOutlined,
  SearchOutlined, FilterOutlined, BarsOutlined, FileOutlined, CameraOutlined,
  FullscreenOutlined, FullscreenExitOutlined, AimOutlined, RetweetOutlined,
  PictureOutlined, PlaySquareOutlined, SmileOutlined,
} from '@ant-design/icons';
import IconAction from '../components/IconAction';
import CommentThread from '../components/CommentThread';
import CollapsibleText from '../components/CollapsibleText';
import { CommentAttachments, AttachmentPicker, type DraftAttachment } from '../components/CommentAttachments';
import { MentionInput } from '../components/MentionInput';
import { LabelPicker } from '../components/LabelPicker';
import AssetInfoPanel from '../components/AssetInfoPanel';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, copyText, formatBytes } from '../api';
import { joinProject, onEvent } from '../realtime';
import { usePlayer } from '../player/usePlayer';
import VideoStage, { ToolBar, type Tool } from '../player/VideoStage';
import Timeline from '../player/Timeline';
import SyncVideoPane, { type SeekRequest } from '../player/SyncVideoPane';
import { useVersionSync, type SyncTarget } from '../player/useVersionSync';
import {
  captureVideoFile, captureToAttachment, captureVideoToCanvas, compositeCaptures,
  canvasToBlob, downloadBlob, captureFilename,
} from '../player/capture';
import { drawShapesToCanvas } from '../player/shapes';
import { Forbidden } from '../layout/AppLayout';
import {
  REVIEW_STATUSES, REVIEW_STATUS_LABEL, COMMENT_LABELS, COMMENT_LABEL_TEXT,
  framesToTimecode, sourceTimecode, roleAtLeast, buildCommentThreads, type Fps, type CustomLabel,
} from '@frametalk/shared';
import type { AssetDto, CommentDto, FrameLinkDto, SessionUser, VersionDto } from '@frametalk/shared';

const STATUS_COLOR: Record<string, string> = {
  pending: 'default', in_review: 'processing', needs_change: 'warning', approved: 'success',
};

const versionFps = (v?: VersionDto | null): Fps => ({ num: v?.fpsNum ?? 25, den: v?.fpsDen ?? 1 });

export default function ReviewPage({ user }: { user: SessionUser }) {
  const { projectId, assetId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { modal } = App.useApp();

  const [tool, setTool] = useState<Tool>('none');
  const [color, setColor] = useState('#ff3b30');
  const [draftShapes, setDraftShapes] = useState<any[]>([]);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<'comments' | 'links' | 'info'>('comments');
  // 左侧剧集列表抽屉（菜单按钮开关）
  const [episodesOpen, setEpisodesOpen] = useState(false);
  // 历史批注归档分组的展开状态（?c= 通知跳转会自动展开对应分组）
  const [openArchived, setOpenArchived] = useState<Record<string, boolean>>({});
  // 批注侧边栏：排序 + 搜索 + @我的 + 筛选（状态/评论人/标签）
  const [sortBy, setSortBy] = useState<'timecode' | 'newest' | 'oldest'>('timecode');
  const [search, setSearch] = useState('');
  const [onlyMentions, setOnlyMentions] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'resolved'>('all');
  const [filterAuthor, setFilterAuthor] = useState('all');
  const [filterLabel, setFilterLabel] = useState('all');
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  // 批注输入区附件（提升到页面级：截帧可直接挂进来）
  const [composerFiles, setComposerFiles] = useState<DraftAttachment[]>([]);
  // A-B 循环（需先设 I/O）
  const [loopAB, setLoopAB] = useState(false);

  /* ---------- 多版本同屏状态 ----------
   * 主窗口固定为最新版（批注/关联帧锚定它，决策见 PLAN.md 第 11 节）；
   * compareIds 为对比窗口装载的版本（最多 3 个），槽位号 = 下标 + 1 */
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [layout, setLayout] = useState<1 | 2 | 4>(1);
  const [offsets, setOffsets] = useState<Record<number, number>>({});
  const [attachedMap, setAttachedMap] = useState<Record<number, boolean>>({});
  const [seekReqs, setSeekReqs] = useState<Record<number, SeekRequest | null>>({});
  const followerEls = useRef<Map<number, HTMLVideoElement>>(new Map());
  const masterElRef = useRef<HTMLVideoElement | null>(null);
  const masterWrapRef = useRef<HTMLDivElement>(null);
  const [masterFs, setMasterFs] = useState(false);

  const detail = useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => api<{ asset: AssetDto; versions: VersionDto[] }>(`/api/assets/${assetId}`),
    retry: false,
  });

  const versions = detail.data?.versions ?? []; // versionNo 降序
  const latest: VersionDto | null = detail.data?.asset.latestVersion ?? versions[0] ?? null;
  const latestId = latest?.id ?? '';
  const latestReady = latest?.status === 'ready';
  const oldVersions = useMemo(() => versions.filter((v) => v.id !== latestId), [versions, latestId]);

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<{ project: any }>(`/api/projects/${projectId}`),
    retry: false,
  });

  const members = useQuery({
    queryKey: ['members', projectId],
    queryFn: () => api<{ members: { userId: string; name: string; role: string; email: string | null }[] }>(`/api/projects/${projectId}/members`),
  });
  const memberNames = useMemo(() => (members.data?.members ?? []).map((m) => m.name), [members.data]);

  // 批注统一挂在最新版上
  const comments = useQuery({
    queryKey: ['comments', latestId],
    queryFn: () => api<{ comments: CommentDto[] }>(`/api/versions/${latestId}/comments`),
    enabled: !!latestId,
  });

  // 历史版本批注：只读归档展示
  const archived = useQueries({
    queries: oldVersions.map((v) => ({
      queryKey: ['comments', v.id],
      queryFn: () => api<{ comments: CommentDto[] }>(`/api/versions/${v.id}/comments`),
      staleTime: 60_000,
    })),
  });

  const linksQuery = useQuery({
    queryKey: ['frame-links', assetId],
    queryFn: () => api<{ links: FrameLinkDto[] }>(`/api/assets/${assetId}/frame-links`),
    enabled: !!assetId,
  });

  const fps: Fps = useMemo(() => versionFps(latest), [latest?.fpsNum, latest?.fpsDen]); // eslint-disable-line react-hooks/exhaustive-deps
  const player = usePlayer(fps, latest?.frameCount ?? null);
  const playerRef = useRef(player);
  playerRef.current = player;

  /* ---------- 同步引擎：主版本 → 对比窗口（时间码对齐 + 每槽偏移） ---------- */
  const syncTargets = useRef<SyncTarget[]>([]);
  const visibleSlots = layout === 1 ? [] : layout === 2 ? [1] : [1, 2, 3];
  const slotVersion = (idx: number): VersionDto | null => {
    const id = compareIds[idx - 1];
    return id ? versions.find((v) => v.id === id) ?? null : null;
  };
  useEffect(() => {
    syncTargets.current = visibleSlots
      .map((idx) => {
        const el = followerEls.current.get(idx);
        const v = slotVersion(idx);
        if (!el || !v || v.status !== 'ready') return null;
        return { el, offset: offsets[idx] ?? 0, attached: attachedMap[idx] !== false };
      })
      .filter(Boolean) as SyncTarget[];
  });
  useVersionSync(masterElRef, syncTargets);

  /* ---------- A-B 循环 ---------- */
  useEffect(() => {
    if (!loopAB) return;
    let raf = 0;
    const tick = () => {
      const p = playerRef.current;
      if (p.playing && p.inFrame != null && p.outFrame != null && p.currentFrame >= p.outFrame) {
        p.seekFrame(p.inFrame);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopAB]);

  useEffect(() => {
    if (projectId) joinProject(projectId);
  }, [projectId]);

  useEffect(() => {
    const off = onEvent((evt: any) => {
      if (evt.type === 'comment:new' || evt.type === 'comment:update') {
        qc.invalidateQueries({ queryKey: ['comments'] });
      }
      if (evt.type === 'version:progress' || evt.type === 'version:status') {
        qc.invalidateQueries({ queryKey: ['asset', assetId] });
      }
      if (evt.type === 'status:change') qc.invalidateQueries({ queryKey: ['asset', assetId] });
      if (evt.type === 'framelink:new' || evt.type === 'framelink:delete') {
        qc.invalidateQueries({ queryKey: ['frame-links', assetId] });
      }
    });
    return off;
  }, [projectId, assetId, qc]);

  // 链接定位：?f=帧号（主版本）；?c=评论ID（通知跳转：选中并滚动到对应批注，
  // 历史版本的归档批注会自动展开归档分组并按时间码换算定位主窗+对比窗）
  const f = params.get('f');
  const cParam = params.get('c');
  const seekOnce = useRef(false);
  const archivedReady = archived.every((q) => !q.isPending);
  useEffect(() => {
    if (!latestReady || seekOnce.current) return;
    if (cParam == null && f == null) return;
    // 等批注数据（最新版 + 全部归档）就绪后再解析目标评论
    if (cParam != null && (!comments.data || !archivedReady)) return;
    seekOnce.current = true;
    // 不设 cleanup：seekOnce 保证只调度一次；player 每次渲染都是新对象，
    // 若进依赖并清定时器，视频加载期的频繁重渲染会把待执行的定位抹掉
    const seekF = () => { if (f != null) playerRef.current.seekFrame(Number(f)); };
    // 滚动到视口内（重试式：等归档分组展开动画/筛选重置渲染稳定）
    const scrollToComment = (id: string) => {
      let tries = 0;
      const attempt = () => {
        const el = document.querySelector(`[data-comment-id="${id}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.top >= 0 && r.bottom <= window.innerHeight) return;
          el.scrollIntoView({ block: 'center' });
        }
        if (++tries < 20) setTimeout(attempt, 150);
      };
      attempt();
    };
    if (cParam == null) { setTimeout(seekF, 300); return; }
    const hit = comments.data!.comments.find((x) => x.id === cParam);
    if (hit) {
      // 目标线程可能被侧栏筛选挡住：先重置筛选再选中定位
      setFilterStatus('all'); setFilterAuthor('all'); setFilterLabel('all');
      setOnlyMentions(false); setSearch('');
      setActiveCommentId(hit.id);
      setTimeout(() => { playerRef.current.seekFrame(hit.frameIn); scrollToComment(hit.id); }, 300);
      return;
    }
    for (let i = 0; i < oldVersions.length; i++) {
      const v = oldVersions[i];
      const ah = v ? (archived[i]?.data?.comments ?? []).find((x) => x.id === cParam) : undefined;
      if (!ah || !v) continue;
      setOpenArchived((prev) => ({ ...prev, [v.id]: true }));
      setTimeout(() => { gotoArchivedComment(v, ah); scrollToComment(ah.id); }, 350);
      return;
    }
    // 评论已被删除：退回帧号定位
    setTimeout(seekF, 300);
  }, [latestReady, f, cParam, comments.data, archivedReady, oldVersions]); // eslint-disable-line react-hooks/exhaustive-deps

  // 切集时 ReviewPage 复用不重挂载：清掉上一集残留状态，并重新从 URL 播种对比窗口
  const seeded = useRef(false);
  useEffect(() => {
    setDraftShapes([]);
    setActiveCommentId(null);
    setComposerFiles([]);
    player.setInFrame(null);
    player.setOutFrame(null);
    seekOnce.current = false;
    seeded.current = false;
    setCompareIds([]);
    setOpenArchived({});
    setLayout(1);
    setOffsets({});
    setAttachedMap({});
    setSeekReqs({});
    followerEls.current.clear();
  }, [assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  // URL 播种：?v= 单版本（旧链接兼容）/ ?vs=id1,id2,id3 多对比窗口
  useEffect(() => {
    if (seeded.current || !detail.data || !latestId) return;
    seeded.current = true;
    const ids = [
      ...(params.get('v') ? [params.get('v')!] : []),
      ...(params.get('vs')?.split(',').filter(Boolean) ?? []),
    ];
    const valid = [...new Set(ids)]
      .filter((id) => id !== latestId && versions.some((v) => v.id === id && v.status === 'ready'))
      .slice(0, 3);
    if (valid.length) {
      setCompareIds(valid);
      setLayout(valid.length === 1 ? 2 : 4);
    }
  }, [detail.data, latestId]); // eslint-disable-line react-hooks/exhaustive-deps

  const myRole = (project.data?.project?.myRole ?? 'viewer') as any;
  const canComment = roleAtLeast(myRole, 'reviewer');
  const canEditStatus = roleAtLeast(myRole, 'reviewer');
  const customLabels: CustomLabel[] = project.data?.project?.customLabels ?? [];

  const addCustomLabel = async (label: CustomLabel) => {
    try {
      await api(`/api/projects/${projectId}`, {
        method: 'PATCH', body: JSON.stringify({ customLabels: [...customLabels, label] }),
      });
      await qc.invalidateQueries({ queryKey: ['project', projectId] });
    } catch (e: any) {
      message.error(e?.message ?? '保存自定义标签失败');
      throw e;
    }
  };

  const setStatus = useMutation({
    mutationFn: (status: string) => api(`/api/assets/${assetId}/review-status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['asset', assetId] }),
    onError: (e: any) => message.error(e.message),
  });

  const createComment = useMutation({
    mutationFn: (payload: any) => api(`/api/versions/${latestId}/comments`, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      setDraftShapes([]);
      setComposerFiles([]);
      qc.invalidateQueries({ queryKey: ['comments', latestId] });
    },
    onError: (e: any) => message.error(e.message),
  });

  // 楼层回复：不清主输入区草稿；帧号后端强制继承父评论
  const replyComment = useMutation({
    mutationFn: (p: { parentId: string; frameIn: number; body: string; mentions: string[] }) =>
      api(`/api/versions/${latestId}/comments`, { method: 'POST', body: JSON.stringify(p) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comments', latestId] }),
    onError: (e: any) => message.error(e.message),
  });
  const handleReply = async (target: CommentDto, root: CommentDto, body: string, mentions: string[]): Promise<boolean> => {
    try {
      await replyComment.mutateAsync({ parentId: target.id, frameIn: root.frameIn, body, mentions });
      return true;
    } catch { return false; }
  };

  const resolveComment = useMutation({
    mutationFn: (c: CommentDto) => api(`/api/comments/${c.id}`, { method: 'PATCH', body: JSON.stringify({ resolved: !c.resolvedAt }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comments', latestId] }),
  });

  const deleteComment = useMutation({
    mutationFn: (id: string) => api(`/api/comments/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comments', latestId] }),
  });

  /* ---------- 关联帧 ---------- */
  const createLink = useMutation({
    mutationFn: (p: { versionId: string; frame: number }) =>
      api<{ link: FrameLinkDto; duplicate?: boolean }>(`/api/assets/${assetId}/frame-links`, {
        method: 'POST',
        body: JSON.stringify({
          baseVersionId: latestId,
          baseFrame: playerRef.current.currentFrame,
          versionId: p.versionId,
          frame: p.frame,
        }),
      }),
    onSuccess: (r) => {
      if (r.duplicate) message.info('该帧关联已存在');
      else message.success('已建立帧关联');
      qc.invalidateQueries({ queryKey: ['frame-links', assetId] });
    },
    onError: (e: any) => message.error(e.message),
  });

  const deleteLink = useMutation({
    mutationFn: (id: string) => api(`/api/frame-links/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['frame-links', assetId] }),
    onError: (e: any) => message.error(e.message),
  });

  /* ---------- 同屏槽位管理 ---------- */
  const addToCompare = (vid: string): number | null => {
    if (!vid || vid === latestId) return null;
    const existing = compareIds.indexOf(vid);
    let slot: number;
    if (existing >= 0) {
      slot = existing + 1;
    } else {
      const next = [...compareIds];
      if (next.length < 3) { next.push(vid); slot = next.length; }
      else { next[2] = vid; slot = 3; }
      setCompareIds(next);
    }
    setLayout((l) => (slot === 1 ? (l < 2 ? 2 : l) : 4) as 1 | 2 | 4);
    return slot;
  };

  const changeSlotVersion = (idx: number, vid: string) => {
    setCompareIds((prev) => {
      const next = prev.map((id, i) => (i === idx - 1 ? vid : id));
      return next.filter((id, i) => next.indexOf(id) === i); // 去掉其他槽位上的重复版本
    });
  };

  const removeFromCompare = (vid: string) => {
    const next = compareIds.filter((id) => id !== vid);
    setCompareIds(next);
    if (next.length === 0) setLayout(1);
  };

  const requestSeek = (slot: number, frame: number) => {
    setSeekReqs((prev) => ({ ...prev, [slot]: { frame, nonce: Date.now() + Math.random() } }));
  };

  const realignSlot = (idx: number) => {
    const el = followerEls.current.get(idx);
    const m = masterElRef.current;
    if (el && m) el.currentTime = Math.max(0, m.currentTime + (offsets[idx] ?? 0));
    setAttachedMap((prev) => ({ ...prev, [idx]: true }));
  };

  const realignAll = () => {
    for (const idx of visibleSlots) {
      if (slotVersion(idx)?.status === 'ready') realignSlot(idx);
    }
  };

  const setSlotOffset = (idx: number, sec: number) => {
    setOffsets((prev) => ({ ...prev, [idx]: sec }));
    const el = followerEls.current.get(idx);
    const m = masterElRef.current;
    if (el && m && attachedMap[idx] !== false) el.currentTime = Math.max(0, m.currentTime + sec);
  };

  const detachSlot = (idx: number) => setAttachedMap((prev) => ({ ...prev, [idx]: false }));

  /* ---------- 截帧 ---------- */
  const assetName = () => detail.data?.asset.name ?? '帧';
  const masterTimecode = () => sourceTimecode(playerRef.current.currentFrame, fps, latest?.startFrames ?? 0);

  const captureMaster = async () => {
    const el = masterElRef.current;
    if (!el || !latestReady) return message.warning('主版本未就绪');
    const ok = await captureVideoFile(el, captureFilename(assetName(), latest!.versionNo, masterTimecode()));
    if (ok) message.success('已截取主版本当前帧');
    else message.error('截帧失败（画面未就绪）');
  };

  const captureMasterToComment = async () => {
    const el = masterElRef.current;
    if (!el || !latestReady) return message.warning('主版本未就绪');
    try {
      const att = await captureToAttachment(el, captureFilename(assetName(), latest!.versionNo, masterTimecode()));
      if (att) {
        setComposerFiles((fl) => [...fl, att]);
        message.success('截图已加入批注附件');
      }
    } catch (e: any) {
      message.error(`截图上传失败: ${e.message}`);
    }
  };

  const captureAll = async () => {
    const items: { canvas: HTMLCanvasElement; label: string }[] = [];
    const m = masterElRef.current;
    if (latestReady && m) {
      const c = captureVideoToCanvas(m);
      if (c) items.push({ canvas: c, label: `v${latest!.versionNo} · 最新（主） · ${masterTimecode()}` });
    }
    for (const idx of visibleSlots) {
      const el = followerEls.current.get(idx);
      const v = slotVersion(idx);
      if (!el || !v || v.status !== 'ready') continue;
      const c = captureVideoToCanvas(el);
      if (!c) continue;
      const vfps = versionFps(v);
      const fr = Math.max(0, Math.round((el.currentTime * vfps.num) / vfps.den));
      items.push({ canvas: c, label: `v${v.versionNo} · 帧 ${fr} · ${sourceTimecode(fr, vfps, v.startFrames ?? 0)}` });
    }
    if (items.length < 2) return message.info('至少两个同屏版本才能合成对比图');
    const out = compositeCaptures(items);
    if (!out) return message.error('合成失败');
    downloadBlob(await canvasToBlob(out), `${assetName()}_同帧对比_${masterTimecode().replace(/:/g, '-')}.png`);
    message.success(`已合成 ${items.length} 个版本的同帧对比图`);
  };

  /* ---------- 跳转 ---------- */
  const gotoLink = (l: FrameLinkDto) => {
    player.seekFrame(l.baseFrame);
    setActiveCommentId(null);
    if (l.versionId !== latestId) {
      const slot = addToCompare(l.versionId);
      if (slot != null) requestSeek(slot, l.frame);
    }
  };

  // 历史批注（帧号属于旧版本）：换算成时间后定位主版本对应帧，并把该版本装入对比窗口
  const gotoArchivedComment = (v: VersionDto, c: CommentDto) => {
    const t = (c.frameIn * (v.fpsDen ?? 1)) / (v.fpsNum ?? 25);
    player.seekFrame(Math.round((t * fps.num) / fps.den));
    const slot = addToCompare(v.id);
    if (slot != null) requestSeek(slot, c.frameIn);
  };

  /* ---------- 主版本全屏 ---------- */
  const toggleMasterFs = () => {
    const w = masterWrapRef.current;
    if (!w) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else w.requestFullscreen().catch(() => {});
  };
  useEffect(() => {
    const onFs = () => setMasterFs(document.fullscreenElement === masterWrapRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const shareLink = async () => {
    const qs = new URLSearchParams();
    if (compareIds.length) qs.set('vs', compareIds.join(','));
    qs.set('f', String(player.currentFrame));
    const url = `${location.origin}/p/${projectId}/a/${assetId}?${qs.toString()}`;
    const ok = await copyText(url);
    message[ok ? 'success' : 'info'](ok ? '链接已复制（含同屏组合与当前帧号）' : url);
  };

  /* ---------- PDF 导出：逐条批注截帧（含画笔） ---------- */
  const exportPdf = async () => {
    const list = comments.data?.comments ?? [];
    if (!list.length) return message.info('暂无批注');
    const v = videoElRef.current;
    if (!v) return;
    message.loading({ content: '正在生成 PDF 截图...', key: 'pdf', duration: 0 });
    const wasPaused = v.paused;
    v.pause();
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth || 1280;
    canvas.height = v.videoHeight || 720;
    const ctx = canvas.getContext('2d')!;
    const items: { commentId: string; image: string }[] = [];
    const seek = (frame: number) => new Promise<void>((resolve) => {
      const onSeeked = () => { v.removeEventListener('seeked', onSeeked); resolve(); };
      v.addEventListener('seeked', onSeeked);
      v.currentTime = ((frame + 0.5) * fps.den) / fps.num;
    });
    try {
      for (const c of list) {
        await seek(c.frameIn);
        await new Promise((r) => setTimeout(r, 60)); // 等呈现
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        if (c.drawing) drawShapesToCanvas(ctx, c.drawing as any, canvas.width, canvas.height);
        items.push({ commentId: c.id, image: canvas.toDataURL('image/jpeg', 0.85) });
      }
      const res = await fetch(`/api/versions/${latestId}/export/pdf`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error(`导出失败 ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${detail.data?.asset.name ?? '批注'}-v${latest?.versionNo}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
      message.success({ content: 'PDF 已导出', key: 'pdf' });
    } catch (err: any) {
      message.error({ content: `导出失败: ${err.message}`, key: 'pdf' });
    } finally {
      if (!wasPaused) v.play().catch(() => {});
      player.seekFrame(player.currentFrame);
    }
  };

  if (detail.isError || project.isError) return <Forbidden />;
  if (detail.isPending) return <div style={{ padding: 48 }}><Spin /></div>;

  const asset = detail.data!.asset;
  // 注意：不能在此处使用 useMemo（前面有条件 return，会造成 hooks 顺序违规）
  const activeComment = comments.data?.comments.find((c) => c.id === activeCommentId) ?? null;
  const overlay = (() => {
    if (!activeComment?.drawing) return null;
    // 选中批注在锚定帧 ±1 内显示（区间批注在区间内显示）
    const inRange = player.currentFrame >= activeComment.frameIn - 1
      && (activeComment.frameOut == null
        ? player.currentFrame <= activeComment.frameIn + 1
        : player.currentFrame <= activeComment.frameOut + 1);
    return inRange ? (activeComment.drawing as any) : null;
  })();

  const commentList = comments.data?.comments ?? [];
  const startFrames = latest?.startFrames ?? 0;
  const frameLinks = linksQuery.data?.links ?? [];
  // 两级楼层线程；时间轴只画楼主（回复继承楼主帧号，避免标记重叠）
  const allThreads = buildCommentThreads(commentList);
  const rootComments = allThreads.map((t) => t.root);
  const archivedGroups = oldVersions.map((v, i) => ({
    version: v,
    threads: buildCommentThreads(archived[i]?.data?.comments ?? []),
    loading: !!archived[i]?.isPending,
  }));

  /* ---------- 侧边栏筛选 + 排序 ---------- */
  const q = search.trim().toLowerCase();
  const hasActiveFilter = filterStatus !== 'all' || filterAuthor !== 'all' || filterLabel !== 'all' || onlyMentions || !!q;
  // 筛选按线程：状态/评论人/标签作用于楼主；搜索与 @我的 命中楼层也算命中该线程
  const visibleThreads = allThreads
    .filter((t) => {
      const c = t.root;
      if (q) {
        const hit = (c.body ?? '').toLowerCase().includes(q)
          || t.floors.some((fl) => (fl.comment.body ?? '').toLowerCase().includes(q));
        if (!hit) return false;
      }
      if (onlyMentions && !(c.mentions ?? []).includes(user.id)
        && !t.floors.some((fl) => (fl.comment.mentions ?? []).includes(user.id))) return false;
      if (filterStatus === 'open' && c.resolvedAt) return false;
      if (filterStatus === 'resolved' && !c.resolvedAt) return false;
      if (filterAuthor !== 'all' && c.authorId !== filterAuthor) return false;
      if (filterLabel !== 'all' && !(c.labels ?? []).includes(filterLabel)) return false;
      return true;
    })
    .sort((a, b) => {
      const x = a.root; const y = b.root;
      if (sortBy === 'newest') return y.createdAt.localeCompare(x.createdAt);
      if (sortBy === 'oldest') return x.createdAt.localeCompare(y.createdAt);
      return x.frameIn - y.frameIn || x.createdAt.localeCompare(y.createdAt); // 时间码
    });
  const resetFilters = () => {
    setFilterStatus('all'); setFilterAuthor('all'); setFilterLabel('all');
    setOnlyMentions(false); setSearch('');
  };
  const filterPanel = (
    <div style={{ width: 230, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>批注状态</div>
        <Select size="small" style={{ width: '100%' }} value={filterStatus} onChange={setFilterStatus}
          options={[
            { value: 'all', label: '全部' },
            { value: 'open', label: '未解决' },
            { value: 'resolved', label: '已解决' },
          ]} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>评论人</div>
        <Select size="small" style={{ width: '100%' }} value={filterAuthor} onChange={setFilterAuthor}
          showSearch optionFilterProp="label"
          options={[
            { value: 'all', label: '全部' },
            ...(members.data?.members ?? []).map((m) => ({ value: m.userId, label: m.name })),
          ]} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>批注标签</div>
        <Select size="small" style={{ width: '100%' }} value={filterLabel} onChange={setFilterLabel}
          options={[
            { value: 'all', label: '全部' },
            ...COMMENT_LABELS.map((l) => ({ value: l as string, label: COMMENT_LABEL_TEXT[l] })),
            ...customLabels.map((c) => ({ value: c.name, label: c.name })),
          ]} />
      </div>
      {hasActiveFilter && (
        <Button size="small" type="link" style={{ padding: 0, width: 'fit-content' }} onClick={resetFilters}>
          清空全部筛选
        </Button>
      )}
    </div>
  );

  /* ---------- 同屏舞台 ---------- */
  const paneBox = layout === 4
    ? { minWidth: 0, minHeight: 0 }
    : { flex: 1, minWidth: 0, minHeight: 0 };

  const versionPickList = (
    <VersionPickList
      versions={versions} latestId={latestId} compareIds={compareIds}
      onAdd={(vid) => addToCompare(vid)} onRemove={removeFromCompare}
    />
  );

  const masterPane = (
    <div
      key="master" ref={masterWrapRef}
      style={{ ...paneBox, position: 'relative', display: 'flex', flexDirection: 'column', background: '#000', overflow: 'hidden', borderRadius: 4 }}
    >
      {latestReady ? (
        <VideoStage
          videoRef={(el) => { player.videoRef(el); masterElRef.current = el; videoElRef.current = el; }}
          src={latestId ? `/api/media/${latestId}/proxy` : undefined}
          poster={latestId ? `/api/media/${latestId}/poster` : undefined}
          displayAspect={latest?.width && latest?.height ? latest.width / latest.height : null}
          overlay={overlay}
          tool={tool}
          color={color}
          draftShapes={draftShapes}
          onSetDraft={setDraftShapes}
        />
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: '#999' }}>
          {!latest ? (
            <Empty description="暂无版本" />
          ) : latest.status === 'transcoding' || latest.status === 'queued' ? (
            <><Spin /><div>最新版转码中 {latest.progress}%</div></>
          ) : (
            <>
              <div>{latest.status === 'failed' ? '最新版转码失败' : '该格式暂不支持在线预览'}</div>
              <Button href={`/api/media/${latest.id}/original`}>下载原片</Button>
            </>
          )}
        </div>
      )}
      <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 10, pointerEvents: 'none' }}>
        <Tag color="blue">v{latest?.versionNo ?? '-'} · 最新 · 主版本</Tag>
      </div>
      {latestReady && (
        <div style={{ position: 'absolute', top: 6, right: 8, zIndex: 10, display: 'flex', gap: 4 }}>
          <Tooltip title="截取主版本当前帧（PNG）">
            <Button size="small" type="text" icon={<CameraOutlined />} onClick={captureMaster}
              style={{ color: '#ccc', background: 'rgba(0,0,0,0.45)' }} />
          </Tooltip>
          <Tooltip title="截帧并加入批注附件">
            <Button size="small" type="text" icon={<PictureOutlined />} onClick={captureMasterToComment}
              style={{ color: '#ccc', background: 'rgba(0,0,0,0.45)' }} />
          </Tooltip>
          <Tooltip title={masterFs ? '退出全屏' : '全屏查看主版本'}>
            <Button size="small" type="text" icon={masterFs ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={toggleMasterFs} style={{ color: '#ccc', background: 'rgba(0,0,0,0.45)' }} />
          </Tooltip>
        </div>
      )}
    </div>
  );

  const renderEmptySlot = (idx: number) => (
    <div
      key={`empty-${idx}`}
      style={{ ...paneBox, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d0d0d', border: '1px dashed #303030', borderRadius: 4 }}
    >
      <Popover trigger="click" placement="bottom" content={versionPickList}>
        <Button icon={<PlaySquareOutlined />}>添加对比版本</Button>
      </Popover>
    </div>
  );

  const renderFollower = (idx: number) => {
    const v = slotVersion(idx);
    if (!v) return renderEmptySlot(idx);
    if (v.status !== 'ready') {
      return (
        <div key={`${idx}-${v.id}`} style={{ ...paneBox, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: '#0d0d0d', color: '#999', borderRadius: 4 }}>
          <Tag color="geekblue">v{v.versionNo}</Tag>
          {v.status === 'transcoding' || v.status === 'queued' ? (
            <><Spin size="small" /><div>转码中 {v.progress}%</div></>
          ) : (
            <div>{v.status === 'failed' ? '转码失败' : '该格式暂不支持在线预览'}</div>
          )}
          <Button size="small" onClick={() => removeFromCompare(v.id)}>移出同屏</Button>
        </div>
      );
    }
    const vfps = versionFps(v);
    return (
      <div key={`${idx}-${v.id}`} style={{ ...paneBox, display: 'flex', position: 'relative', borderRadius: 4, overflow: 'hidden' }}>
        <SyncVideoPane
          version={v}
          fps={vfps}
          offset={offsets[idx] ?? 0}
          attached={attachedMap[idx] !== false}
          seekRequest={seekReqs[idx] ?? null}
          getSyncTime={() => Math.max(0, (masterElRef.current?.currentTime ?? 0) + (offsets[idx] ?? 0))}
          getMasterPlaying={() => !!masterElRef.current && !masterElRef.current.paused}
          registerEl={(el) => { if (el) followerEls.current.set(idx, el); else followerEls.current.delete(idx); }}
          onDetach={() => detachSlot(idx)}
          onRealign={() => realignSlot(idx)}
          onClose={() => removeFromCompare(v.id)}
          onCapture={async (el) => {
            const fr = Math.max(0, Math.round((el.currentTime * vfps.num) / vfps.den));
            const ok = await captureVideoFile(el, captureFilename(assetName(), v.versionNo, sourceTimecode(fr, vfps, v.startFrames ?? 0)));
            if (ok) message.success(`已截取 v${v.versionNo} 当前帧`);
            else message.error('截帧失败（画面未就绪）');
          }}
          onLink={(frame) => createLink.mutate({ versionId: v.id, frame })}
          onOffsetChange={(sec) => setSlotOffset(idx, sec)}
          versionOptions={versions
            .filter((x) => x.id !== latestId && x.id !== v.id && !compareIds.includes(x.id))
            .map((x) => ({ value: x.id, label: `v${x.versionNo}${x.status !== 'ready' ? '（不可播）' : ''}` }))}
          onChangeVersion={(vid) => changeSlotVersion(idx, vid)}
          canEdit={canComment}
        />
      </div>
    );
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* 顶栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #262626', flexShrink: 0 }}>
        <Link to={`/p/${projectId}`}><Button icon={<LeftOutlined />} title="返回项目" /></Link>
        <Button icon={<BarsOutlined />} title="剧集列表" type={episodesOpen ? 'primary' : 'default'} onClick={() => setEpisodesOpen((v) => !v)} />
        <b style={{ fontSize: 16 }}>{asset.name}</b>
        <Tag color="blue">批注基于最新版 v{latest?.versionNo ?? '-'}</Tag>
        {canEditStatus && (
          <Select
            size="small" value={asset.reviewStatus} style={{ width: 110 }}
            onChange={(status) => setStatus.mutate(status)}
            options={REVIEW_STATUSES.map((s) => ({ value: s, label: REVIEW_STATUS_LABEL[s] }))}
          />
        )}
        <div style={{ flex: 1 }} />
        <Button size="small" icon={<LinkOutlined />} onClick={shareLink}>复制链接</Button>
        <Dropdown menu={{
          items: [
            { key: 'csv', label: <a href={`/api/versions/${latestId}/export/csv`}>修改清单 CSV</a> },
            { key: 'edl', label: <a href={`/api/versions/${latestId}/export/edl`}>Resolve EDL 标记</a> },
            { key: 'xml', label: <a href={`/api/versions/${latestId}/export/xml`}>Premiere/FCP XML 标记</a> },
            { key: 'pdf', label: <span onClick={exportPdf}>修改清单 PDF（含帧截图）</span> },
          ],
        }}>
          <Button size="small" icon={<ExportOutlined />}>导出</Button>
        </Dropdown>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* 左侧剧集栏：与批注页同级，展开时可直接切换剧集 */}
        {episodesOpen && (
          <EpisodeSidebar
            projectId={projectId} projectName={project.data?.project?.name}
            currentAssetId={assetId} onClose={() => setEpisodesOpen(false)}
          />
        )}
        {/* 播放器区：主版本 + 最多 3 个对比窗口 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div
            data-testid="multi-stage"
            style={layout === 4
              ? { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 2, padding: 2 }
              : { flex: 1, minHeight: 0, display: 'flex', gap: 2, padding: 2 }}
          >
            {masterPane}
            {layout >= 2 && renderFollower(1)}
            {layout === 4 && renderFollower(2)}
            {layout === 4 && renderFollower(3)}
          </div>
          {/* 控制条 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 4px', flexWrap: 'wrap', flexShrink: 0 }}>
            <Space size={4}>
              <Button type="text" icon={<StepBackwardFilled />} onClick={() => player.step(-1)} title="← 上一帧" />
              <Button type="text" size="large" icon={player.playing ? <PauseOutlined /> : <PlayCircleOutlined />} onClick={player.togglePlay} title="空格" />
              <Button type="text" icon={<StepForwardFilled />} onClick={() => player.step(1)} title="→ 下一帧" />
              <Select size="small" value={player.rate} style={{ width: 74 }}
                onChange={player.setRate}
                options={[0.5, 1, 2, 4].map((r) => ({ value: r, label: `${r}x` }))} />
              <Button size="small" onClick={() => player.setInFrame(player.inFrame != null ? null : player.currentFrame)}>
                {player.inFrame != null ? `I ${framesToTimecode(startFrames + player.inFrame, fps)}` : '设 I'}
              </Button>
              <Button size="small" onClick={() => player.setOutFrame(player.outFrame != null ? null : player.currentFrame)}>
                {player.outFrame != null ? `O ${framesToTimecode(startFrames + player.outFrame, fps)}` : '设 O'}
              </Button>
              <Tooltip title="A-B 循环播放 I/O 区间（全部窗口同步）">
                <Button size="small" type={loopAB ? 'primary' : 'default'} icon={<RetweetOutlined />}
                  disabled={player.inFrame == null || player.outFrame == null}
                  onClick={() => setLoopAB((x) => !x)}>循环</Button>
              </Tooltip>
            </Space>
            <div style={{ width: 1, height: 20, background: '#262626' }} />
            <Segmented
              size="small" value={layout}
              onChange={(v) => setLayout(v as 1 | 2 | 4)}
              options={[{ value: 1, label: '单屏' }, { value: 2, label: '双屏' }, { value: 4, label: '四屏' }]}
            />
            <Popover trigger="click" placement="bottomLeft" content={versionPickList}>
              <Button size="small" icon={<PlaySquareOutlined />}>
                版本同屏{compareIds.length ? ` · ${compareIds.length}` : ''}
              </Button>
            </Popover>
            <Tooltip title="所有对比窗口对齐回主版本当前时间">
              <Button size="small" icon={<AimOutlined />} onClick={realignAll} disabled={!compareIds.length}>全部对齐</Button>
            </Tooltip>
            <div style={{ flex: 1 }} />
            <Button size="small" icon={<CameraOutlined />} disabled={!latestReady} onClick={captureMaster}>截帧</Button>
            <Button size="small" icon={<PictureOutlined />} disabled={!latestReady} onClick={captureAll}>全截帧</Button>
            {draftShapes.length > 0 && (
              <Tag color="processing">{draftShapes.length} 个画笔待提交 ↓</Tag>
            )}
          </div>
          <Timeline
            player={player}
            fps={fps}
            frameCount={latest?.frameCount ?? null}
            durationSec={latest?.durationSec ?? null}
            startFrames={startFrames}
            sprite={latest?.sprite ?? null}
            spriteUrl={latestId ? `/api/media/${latestId}/sprite` : undefined}
            posterUrl={latestId ? `/api/media/${latestId}/poster` : undefined}
            waveformUrl={latestId ? `/api/media/${latestId}/waveform` : undefined}
            comments={rootComments}
            activeCommentId={activeCommentId}
          />
          {/* 批注栏：位于播放器下方，与播放器同宽；始终提交到最新版 */}
          <CommentComposer
            members={members.data?.members ?? []}
            frameLabel={`帧 ${player.currentFrame} · ${sourceTimecode(player.currentFrame, fps, startFrames)}`}
            range={[player.inFrame, player.outFrame]}
            tools={(
              <>
                <ToolBar tool={tool} setTool={setTool} color={color} setColor={setColor}
                  onClear={() => setDraftShapes([])} disabled={!canComment} />
                {draftShapes.length > 0 && <Tag color="processing">{draftShapes.length} 个画笔</Tag>}
              </>
            )}
            customLabels={customLabels}
            onAddCustom={addCustomLabel}
            canManage={roleAtLeast(myRole, 'manager')}
            files={composerFiles}
            setFiles={setComposerFiles}
            onSubmit={(payload) => createComment.mutate({
              ...payload,
              frameIn: payload.frameIn ?? player.currentFrame,
              drawing: draftShapes.length ? { shapes: draftShapes } : undefined,
            })}
            disabled={!canComment || !latestReady}
          />
        </div>

        {/* 右侧栏：批注 / 关联帧 / 信息 */}
        <div style={{ width: 380, borderLeft: '1px solid #262626', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '0 14px', flexShrink: 0 }}>
            <Tabs
              size="small" activeKey={sideTab}
              onChange={(k) => setSideTab(k as 'comments' | 'links' | 'info')}
              items={[
                { key: 'comments', label: `批注${commentList.length ? ` · ${commentList.length}` : ''}` },
                { key: 'links', label: `关联帧${frameLinks.length ? ` · ${frameLinks.length}` : ''}` },
                { key: 'info', label: '信息' },
              ]}
              tabBarStyle={{ margin: 0 }}
            />
          </div>
          {sideTab === 'comments' ? (
          <>
          {/* 工具条：排序 | 搜索 | @我的 | 筛选（气泡：状态/评论人/标签） */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #262626', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <Select size="small" value={sortBy} onChange={setSortBy} style={{ width: 104 }}
              options={[
                { value: 'timecode', label: '时间码' },
                { value: 'newest', label: '最新批注' },
                { value: 'oldest', label: '最早批注' },
              ]} />
            <Input size="small" allowClear prefix={<SearchOutlined style={{ color: '#888' }} />}
              placeholder="搜索批注" value={search} onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 80 }} />
            <Tooltip title="只看 @我的">
              <Button size="small" type={onlyMentions ? 'primary' : 'default'}
                style={{ fontWeight: 600, paddingInline: 8 }}
                onClick={() => setOnlyMentions((v) => !v)}>@</Button>
            </Tooltip>
            <Popover trigger="click" placement="bottomRight" content={filterPanel}>
              <Badge dot={hasActiveFilter} offset={[-3, 3]} color="#4f7cff">
                <Button size="small" icon={<FilterOutlined />} />
              </Badge>
            </Popover>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {visibleThreads.length === 0 && (
              <Empty style={{ marginTop: 48 }} description={hasActiveFilter ? '无匹配批注' : '暂无批注'} />
            )}
            {visibleThreads.map((t) => (
              <CommentThread
                key={t.root.id}
                thread={t}
                userId={user.id}
                myRole={myRole}
                canReply={canComment && latestReady}
                members={members.data?.members ?? []}
                fps={fps}
                startFrames={startFrames}
                customLabels={customLabels}
                activeCommentId={activeCommentId}
                onSelect={(id, frameIn) => { setActiveCommentId(id); player.seekFrame(frameIn); }}
                onResolve={(c) => resolveComment.mutate(c)}
                onDelete={(id) => deleteComment.mutate(id)}
                onReply={handleReply}
              />
            ))}
            {/* 历史版本批注：只读归档（决策 2026-10-24），点击跳转主版本对应时间 */}
            {archivedGroups.map((g) => (g.loading || g.threads.length > 0) && (
              <Collapse
                key={g.version.id} ghost size="small"
                activeKey={openArchived[g.version.id] ? ['archived'] : []}
                onChange={(keys) => setOpenArchived((prev) => ({ ...prev, [g.version.id]: (keys as string[]).includes('archived') }))}
                items={[{
                  key: 'archived',
                  label: (
                    <span style={{ fontSize: 12, color: '#888' }}>
                      v{g.version.versionNo} 历史批注 · {g.loading ? '…' : `${g.threads.reduce((n, t) => n + 1 + t.floors.length, 0)} 条`}（只读归档）
                    </span>
                  ),
                  children: g.loading ? <Spin size="small" /> : (
                    <div>
                      {g.threads.map((t) => (
                        <div key={t.root.id} style={{ borderBottom: '1px solid #1f1f1f' }}>
                          <div
                            data-comment-id={t.root.id}
                            onClick={() => gotoArchivedComment(g.version, t.root)}
                            style={{ padding: '6px 8px', cursor: 'pointer', opacity: t.root.resolvedAt ? 0.6 : 0.9 }}
                          >
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
                              <b>{t.root.authorName}</b>
                              <span style={{ fontFamily: 'monospace', color: '#8c8c8c' }}>
                                {sourceTimecode(t.root.frameIn, versionFps(g.version), g.version.startFrames ?? 0)}
                              </span>
                              {t.root.resolvedAt && <Tag color="success" style={{ fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>已解决</Tag>}
                              {t.floors.length > 0 && <span style={{ color: '#666', fontSize: 11 }}>{t.floors.length} 条回复</span>}
                            </div>
                            {t.root.body && (
                              <div style={{ marginTop: 2 }}><CollapsibleText text={t.root.body} maxLines={4} fontSize={12} color="#bbb" mentionNames={memberNames} /></div>
                            )}
                            <CommentAttachments attachments={t.root.attachments ?? []} />
                          </div>
                          {t.floors.length > 0 && (
                            <div style={{ margin: '0 8px 6px 14px', paddingLeft: 8, borderLeft: '2px solid #262626' }}>
                              {t.floors.map((fl) => (
                                <div
                                  key={fl.comment.id}
                                  data-comment-id={fl.comment.id}
                                  onClick={() => gotoArchivedComment(g.version, fl.comment)}
                                  style={{ padding: '4px', cursor: 'pointer' }}
                                >
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
                                    <span style={{ color: '#555', fontSize: 11, fontFamily: 'monospace' }}>{fl.floor}楼</span>
                                    <b>{fl.comment.authorName}</b>
                                    {fl.replyToName && <span style={{ color: '#8c8c8c' }}>回复 <b style={{ color: '#4f9dff' }}>@{fl.replyToName}</b></span>}
                                  </div>
                                  {fl.comment.body && (
                                    <div style={{ marginTop: 2 }}><CollapsibleText text={fl.comment.body} maxLines={3} fontSize={12} color="#bbb" mentionNames={memberNames} /></div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ),
                }]}
              />
            ))}
          </div>
          </>
          ) : sideTab === 'links' ? (
            <div style={{ flex: 1, overflow: 'auto' }}>
              {frameLinks.length === 0 && (
                <Empty style={{ marginTop: 48 }}
                  description={<span style={{ fontSize: 12 }}>暂无关联帧<br />在对比窗口点 <LinkOutlined /> 按钮，将其当前帧与主版本当前帧关联</span>} />
              )}
              {frameLinks.map((l) => {
                const tv = versions.find((v) => v.id === l.versionId);
                const tfps = versionFps(tv);
                return (
                  <div key={l.id} style={{ padding: '8px 14px', borderBottom: '1px solid #1f1f1f' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Tag color="blue" style={{ marginInlineEnd: 0, fontFamily: 'monospace' }}>
                        v{latest?.versionNo} 帧 {l.baseFrame} · {sourceTimecode(l.baseFrame, fps, startFrames)}
                      </Tag>
                      <span style={{ color: '#888' }}>↔</span>
                      <Tag color="geekblue" style={{ marginInlineEnd: 0, fontFamily: 'monospace' }}>
                        v{tv?.versionNo ?? '?'} 帧 {l.frame} · {sourceTimecode(l.frame, tfps, tv?.startFrames ?? 0)}
                      </Tag>
                    </div>
                    {l.note && <div style={{ marginTop: 4, fontSize: 12, color: '#bbb' }}>{l.note}</div>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                      <span style={{ color: '#666', fontSize: 12 }}>{l.creatorName} · {new Date(l.createdAt).toLocaleString('zh-CN')}</span>
                      <div style={{ flex: 1 }} />
                      <Button size="small" type="link" style={{ padding: 0 }} onClick={() => gotoLink(l)}>跳转</Button>
                      {(l.createdBy === user.id || roleAtLeast(myRole, 'manager')) && (
                        <IconAction
                          icon={<DeleteOutlined />} tooltip="删除关联" danger
                          confirm="删除这条帧关联？"
                          onConfirm={() => deleteLink.mutate(l.id)}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <AssetInfoPanel
              asset={asset}
              version={latest ?? undefined}
              projectName={project.data?.project?.name}
              canEdit={roleAtLeast(myRole, 'editor')}
              onSaved={() => qc.invalidateQueries({ queryKey: ['asset', assetId] })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- 版本同屏选择列表（Popover 内容 / 空槽位复用） ---------- */

function VersionPickList({ versions, latestId, compareIds, onAdd, onRemove }: {
  versions: VersionDto[];
  latestId: string;
  compareIds: string[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div style={{ width: 320, maxHeight: 380, overflow: 'auto' }}>
      {versions.map((v) => {
        const isLatest = v.id === latestId;
        const inCompare = compareIds.includes(v.id);
        const statusText = v.status === 'ready' ? ''
          : v.status === 'transcoding' || v.status === 'queued' ? `转码中 ${v.progress}%`
          : v.status === 'failed' ? '转码失败'
          : v.status === 'unsupported' ? '仅存储'
          : v.status;
        return (
          <div key={v.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 4px', borderBottom: '1px solid #1f1f1f' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>
                <b>v{v.versionNo}</b>
                {isLatest && <Tag color="blue" style={{ marginLeft: 6 }}>最新 · 主版本</Tag>}
                {statusText && <Tag style={{ marginLeft: 6 }}>{statusText}</Tag>}
              </div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {v.originalName} · {formatBytes(v.size)} · {new Date(v.createdAt).toLocaleString('zh-CN')}
                {v.uploadedByName ? ` · ${v.uploadedByName}` : ''}
              </div>
            </div>
            {isLatest ? null : inCompare ? (
              <Button size="small" danger ghost onClick={() => onRemove(v.id)}>移除</Button>
            ) : (
              <Button size="small" type="primary" ghost disabled={v.status !== 'ready'} onClick={() => onAdd(v.id)}>加入同屏</Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- 左侧剧集栏：与批注页同级，点击直接切换剧集（不关闭，便于连续切换） ---------- */

function EpisodeSidebar({ projectId, projectName, currentAssetId, onClose }: {
  projectId?: string;
  projectName?: string;
  currentAssetId?: string;
  onClose: () => void;
}) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  // 与项目页共享 ['assets', projectId, null, false, ''] 缓存（全部文件视图）
  const assets = useQuery({
    queryKey: ['assets', projectId, null, false, ''],
    queryFn: () => api<{ assets: AssetDto[] }>(`/api/projects/${projectId}/assets`),
    enabled: !!projectId,
  });

  const kw = q.trim().toLowerCase();
  const list = (assets.data?.assets ?? []).filter((a) => !kw || a.name.toLowerCase().includes(kw));

  return (
    <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid #262626', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 8px', flexShrink: 0 }}>
        <b style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }} title={projectName}>
          剧集列表{projectName ? ` · ${projectName}` : ''}
        </b>
        <Button size="small" type="text" icon={<BarsOutlined />} title="收起剧集列表" onClick={onClose} />
      </div>
      <div style={{ padding: '0 12px 10px', flexShrink: 0 }}>
        <Input
          size="small" allowClear prefix={<SearchOutlined style={{ color: '#888' }} />}
          placeholder="搜索剧集" value={q} onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {assets.isPending && <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>}
        {!assets.isPending && list.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 48 }} description={kw ? '无匹配剧集' : '暂无剧集'} />
        )}
        {list.map((a) => {
          const v = a.latestVersion;
          const active = a.id === currentAssetId;
          const vStatus = v == null ? ''
            : v.status === 'ready' ? ''
            : v.status === 'transcoding' || v.status === 'queued' ? ` · 转码中 ${v.progress}%`
            : v.status === 'failed' ? ' · 转码失败'
            : v.status === 'unsupported' ? ' · 仅存储'
            : ` · ${v.status}`;
          return (
            <div
              key={a.id}
              onClick={() => {
                if (!active) nav(`/p/${projectId}/a/${a.id}${v ? `?v=${v.id}` : ''}`);
              }}
              style={{
                display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px',
                cursor: 'pointer', borderBottom: '1px solid #1f1f1f',
                background: active ? 'rgba(79,124,255,0.12)' : undefined,
              }}
            >
              {v?.hasPoster ? (
                <img src={`/api/assets/${a.id}/poster`} style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} alt="" />
              ) : (
                <div style={{ width: 64, height: 36, borderRadius: 4, background: '#1f1f1f', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <FileOutlined style={{ color: '#555' }} />
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: active ? 600 : 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name}
                  {active && <Tag color="processing" style={{ marginLeft: 6 }}>当前</Tag>}
                </div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                  v{v?.versionNo ?? 0}{vStatus}
                </div>
              </div>
              <Tag color={STATUS_COLOR[a.reviewStatus]} style={{ marginRight: 0, flexShrink: 0 }}>
                {REVIEW_STATUS_LABEL[a.reviewStatus as keyof typeof REVIEW_STATUS_LABEL]}
              </Tag>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 批注输入区：位于播放器下方，与播放器同宽；files 由页面级托管（截帧可挂入） ---------- */

/** QQ 经典表情（Unicode 近似）：[字符, QQ 名称] */
const QQ_EMOJIS: [string, string][] = [
  ['🙂', '微笑'], ['😁', '呲牙'], ['😄', '憨笑'], ['😏', '得意'],
  ['😍', '色'], ['😳', '发呆'], ['😕', '撇嘴'], ['😊', '害羞'],
  ['😢', '流泪'], ['😭', '大哭'], ['😅', '尴尬'], ['😡', '发怒'],
  ['😜', '调皮'], ['😲', '惊讶'], ['☹', '难过'], ['😎', '酷'],
  ['😓', '冷汗'], ['😤', '抓狂'], ['😝', '吐'], ['🤭', '偷笑'],
  ['🥰', '可爱'], ['🙄', '白眼'], ['😒', '鄙视'], ['🤤', '饥饿'],
  ['😪', '困'], ['😱', '惊恐'], ['😖', '折磨'], ['😞', '衰'],
  ['😘', '亲亲'], ['😨', '吓'], ['🥺', '可怜'], ['😥', '擦汗'],
  ['🤐', '闭嘴'], ['😴', '睡'], ['🥱', '哈欠'], ['😌', '悠闲'],
  ['🤫', '嘘'], ['😵', '晕'], ['😬', '龇牙'], ['🤓', '书呆子'],
  ['😈', '坏笑'], ['🙈', '糗大了'], ['😷', '口罩'], ['🤒', '生病'],
  ['🤢', '吐了'], ['🥳', '庆祝'], ['🤗', '拥抱'], ['😺', '笑脸'],
  ['👍', '强'], ['👎', '弱'], ['🤝', '握手'], ['✌', '胜利'],
  ['🙏', '抱拳'], ['👌', 'OK'], ['✊', '拳头'], ['👏', '鼓掌'],
  ['👋', '再见'], ['💪', '奋斗'], ['❤', '爱心'], ['💔', '心碎'],
  ['🌹', '玫瑰'], ['🎉', '礼花'], ['⚡', '闪电'], ['💩', '便便'],
];

function CommentComposer({
  members, onSubmit, disabled, frameLabel, range, tools, customLabels, onAddCustom, canManage, files, setFiles,
}: {
  members: { userId: string; name: string; role?: string; email?: string | null }[];
  onSubmit?: (payload: any) => void;
  disabled?: boolean;
  frameLabel?: string;
  range?: [number | null, number | null];
  tools?: React.ReactNode;
  customLabels?: CustomLabel[];
  onAddCustom?: (label: CustomLabel) => Promise<void> | void;
  canManage?: boolean;
  files: DraftAttachment[];
  setFiles: (f: DraftAttachment[]) => void;
}) {
  const [text, setText] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [mentions, setMentions] = useState<string[]>([]);
  const [useRange, setUseRange] = useState(false);
  const [sending, setSending] = useState(false);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const rangeIn = range?.[0] ?? null;
  const rangeOut = range?.[1] ?? null;

  // 表情在光标处插入；无焦点信息时追加到末尾
  // 光标恢复放在 commit 后的 layout effect 同步执行——rAF 在后台/不可见页面不触发，光标会留在末尾
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current == null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    const el = textAreaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(pos, pos);
  });
  const insertEmoji = (em: string) => {
    const el = textAreaRef.current;
    const caret = el ? (el.selectionStart ?? text.length) : text.length;
    pendingCaret.current = caret + em.length;
    setText(text.slice(0, caret) + em + text.slice(caret));
  };

  if (disabled && !onSubmit) {
    return <div style={{ padding: 12, color: '#888' }}>需要审阅及以上角色才能批注</div>;
  }

  return (
    <div style={{ padding: '10px 16px 12px', borderTop: '1px solid #262626', flexShrink: 0 }}>
      <MentionInput
        value={text} onChange={setText}
        mentions={mentions} setMentions={setMentions}
        members={members}
        placeholder="写批注..." rows={2} disabled={disabled}
        inputRef={textAreaRef}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {frameLabel && <Tag style={{ marginInlineEnd: 0, fontFamily: 'monospace' }}>{frameLabel}</Tag>}
        {rangeIn != null && rangeOut != null && (
          <Checkbox checked={useRange} onChange={(e) => setUseRange(e.target.checked)} disabled={disabled}>
            区间 {rangeIn}~{rangeOut}
          </Checkbox>
        )}
        <div style={{ flex: 1 }} />
        {tools}
        <LabelPicker
          value={labels} onChange={setLabels}
          customLabels={customLabels ?? []}
          onAddCustom={onAddCustom ?? (() => {})}
          canManage={!!canManage}
          disabled={disabled}
        />
        <Popover
          trigger="click" placement="topRight"
          content={(
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 30px)', gap: 2 }}>
              {QQ_EMOJIS.map(([ch, name]) => (
                <Tooltip key={name} title={name}>
                  <Button type="text" size="small" onClick={() => insertEmoji(ch)}
                    style={{ fontSize: 17, width: 30, height: 28, padding: 0 }}>{ch}</Button>
                </Tooltip>
              ))}
            </div>
          )}
        >
          <Tooltip title="表情">
            <Button size="small" type="text" icon={<SmileOutlined />} disabled={disabled} />
          </Tooltip>
        </Popover>
        <AttachmentPicker files={files} setFiles={setFiles} disabled={disabled} />
        {onSubmit && (
          <Button type="primary" disabled={disabled} icon={<SendOutlined />} loading={sending}
            onClick={async () => {
              const payload = {
                body: text || undefined,
                labels,
                mentions,
                attachmentIds: files.map((f) => f.id),
                ...(useRange && rangeIn != null && rangeOut != null && rangeOut > rangeIn
                  ? { frameIn: rangeIn, frameOut: rangeOut }
                  : {}),
              };
              setSending(true);
              try { onSubmit(payload); setText(''); setLabels([]); setMentions([]); setFiles([]);
              } finally { setSending(false); }
            }}>
            发送
          </Button>
        )}
      </div>
    </div>
  );
}
