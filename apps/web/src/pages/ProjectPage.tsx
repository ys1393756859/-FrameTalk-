import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  Button, Tag, App, Input, Select, Space, Tree, Segmented, Card,
  Progress, Empty, Popconfirm, Drawer, List, Tooltip, Checkbox, Modal, Form,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes, formatDuration } from '../api';
import { joinProject, onEvent } from '../realtime';
import {
  PlusOutlined, FolderAddOutlined, UploadOutlined, TeamOutlined, DeleteOutlined,
  RestOutlined, DownloadOutlined, SearchOutlined, AppstoreOutlined, BarsOutlined, PlayCircleOutlined, FileOutlined, EditOutlined, UndoOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons';
import zhCN from '@uppy/locales/lib/zh_CN';
import DataTable from '../components/DataTable';
import IconAction from '../components/IconAction';
import Uppy from '@uppy/core';
import DashboardPlugin from '@uppy/dashboard';
import Tus from '@uppy/tus';
import '@uppy/core/css/style.css';
import '@uppy/dashboard/css/style.css';
import type { AssetDto, FolderDto, ProjectSummary, SessionUser } from '@frametalk/shared';
import { REVIEW_STATUS_LABEL, ROLE_LABEL, PROJECT_ROLES, roleAtLeast, type ProjectRole } from '@frametalk/shared';
import { Forbidden } from '../layout/AppLayout';

const STATUS_COLOR: Record<string, string> = {
  pending: 'default', in_review: 'processing', needs_change: 'warning', approved: 'success',
};
const TITLE_COLOR: Record<string, string> = {
  导演: 'gold', 制片: 'purple', 剪辑: 'cyan', 生成: 'geekblue',
};
const VSTATUS_COLOR: Record<string, string> = {
  uploading: 'default', queued: 'default', transcoding: 'processing', ready: 'success', failed: 'error', unsupported: 'warning',
};

export default function ProjectPage({ user }: { user: SessionUser }) {
  const { projectId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [trash, setTrash] = useState(false);
  const [search, setSearch] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<'grid' | 'table'>(() =>
    (localStorage.getItem('ft-assets-view') as 'grid' | 'table') || 'table');
  useEffect(() => { localStorage.setItem('ft-assets-view', view); }, [view]);
  const uppyRef = useRef<Uppy | null>(null);
  const versionFilterTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<{ project: any }>(`/api/projects/${projectId}`),
    retry: false,
  });

  const folders = useQuery({
    queryKey: ['folders', projectId],
    queryFn: () => api<{ folders: FolderDto[] }>(`/api/projects/${projectId}/folders`),
    enabled: !!projectId,
  });

  const assets = useQuery({
    queryKey: ['assets', projectId, folderId, trash, search],
    queryFn: () => {
      const p = new URLSearchParams();
      if (trash) p.set('trash', '1');
      else if (folderId) p.set('folderId', folderId);
      if (search) p.set('search', search);
      return api<{ assets: AssetDto[] }>(`/api/projects/${projectId}/assets?${p}`);
    },
    enabled: !!projectId,
    refetchInterval: (q) => {
      const list = q.state.data?.assets ?? [];
      return list.some((a) => a.latestVersion && ['queued', 'transcoding'].includes(a.latestVersion.status)) ? 3000 : false;
    },
  });

  useEffect(() => {
    if (projectId) joinProject(projectId);
    const off = onEvent(() => qc.invalidateQueries({ queryKey: ['assets', projectId] }));
    return off;
  }, [projectId, qc]);

  const myRole = (project.data?.project?.myRole ?? 'viewer') as ProjectRole | 'admin';
  const canEdit = roleAtLeast(myRole, 'editor');
  const isManager = roleAtLeast(myRole, 'manager');

  /* ---------- 上传（tus 断点续传） ---------- */
  const uppy = useMemo(() => {
    if (!projectId) return null;
    // 分片自适应：内网大块省协议开销，小文件整块直传
    const chunkSize = navigator.hardwareConcurrency && navigator.hardwareConcurrency >= 8
      ? 64 * 1024 * 1024  // 64 MB：内网千兆，8 核以上机器
      : 32 * 1024 * 1024; // 32 MB
    const u = new Uppy({
      autoProceed: true,
      restrictions: { maxFileSize: 1024 * 1024 ** 3 },
      // 同名同大小同类型 = 同一文件：刷新/重选后续传（tus-js-client 默认 localStorageUrlStorage 持久化）
      // relPath 参与比较：文件夹上传时不同子目录下的同名文件都要保留
      onBeforeFileAdded: (newFile, files) => {
        return !Object.values(files).some(
          (f: any) => f.name === newFile.name && f.size === newFile.size && f.type === newFile.type
            && (f.meta?.relPath ?? '') === ((newFile as any).meta?.relPath ?? ''),
        );
      },
    });
    u.use(Tus, {
      endpoint: '/api/uploads',
      chunkSize,
      withCredentials: true,
      // 成功后清除续传记录；失败/中断的保留，下次自动续传
      removeFingerprintOnSuccess: true,
      // 断网/5xx 自动重试：先快后慢，共 7 次（约 2 分钟容忍网络抖动）
      retryDelays: [1000, 3000, 5000, 10000, 15000, 30000, 60000],
      // 并发分片：内网带宽充足时 3 路并行提高吞吐（tus 协议按 offset 顺序提交）
      limit: 3,
      // 注意：不要在这里动请求头。tus-js-client v4 底层是 Fetch 实现，
      // 手动 setHeader('Tus-Resumable') 会破坏其版本头导致服务端 400。
    });
    u.on('file-added', (file) => {
      const meta = uppyMeta.get(projectId!) ?? {};
      u.setFileMeta(file.id, { projectId, ...meta });
    });
    u.on('upload-success', (_file: any) => {
      // 上传成功后清掉 assetId：后续再传文件一律当新资产，避免指向已删除/不存在的资产
      const meta = uppyMeta.get(projectId!);
      if (meta?.assetId) uppyMeta.set(projectId!, { ...meta, assetId: undefined });
      qc.invalidateQueries({ queryKey: ['assets', projectId] });
    });
    u.on('upload-error', (file: any, err: any) => {
      const msg = String(err?.message ?? err);
      // 目标资产/文件夹已不存在：剥掉文件身上的失效引用，重试时按新素材传（folder 由服务端落到根目录）
      if ((file?.meta?.assetId && msg.includes('资产不存在'))
        || (file?.meta?.folderId && /folderId|fkey|文件夹/.test(msg))) {
        u.setFileMeta(file.id, { ...file.meta, assetId: undefined, folderId: undefined });
        message.warning(`「${file.name}」引用的目标已失效，点"重试"将作为新素材上传`);
        return;
      }
      message.error({
        content: `「${file?.name ?? ''}」上传失败：${msg}。不要关闭页面，点击"重试"可从断点继续`,
        key: `err-${file?.id}`,
        duration: 10,
      });
    });
    u.on('complete', (result) => {
      if ((result.failed?.length ?? 0) === 0) {
        message.success(`上传完成 ${result.successful?.length ?? 0} 个文件`);
        qc.invalidateQueries({ queryKey: ['assets', projectId] });
      } else {
        message.warning(`${result.successful?.length ?? 0} 个成功，${result.failed?.length ?? 0} 个失败（可在上传面板中重试，已传分片不丢失）`);
        qc.invalidateQueries({ queryKey: ['assets', projectId] });
      }
    });
    return u;
  }, [projectId, qc, message]);

  const uppyMeta = useMemo(() => new Map<string, { folderId?: string; assetId?: string }>(), []);

  useEffect(() => {
    uppyMeta.set(projectId ?? '', { folderId: folderId ?? undefined });
  }, [projectId, folderId, uppyMeta]);

  const [uploadAsset, setUploadAsset] = useState<AssetDto | null>(null);
  const openUpload = (asset?: AssetDto) => {
    uppyMeta.set(projectId!, { folderId: folderId ?? undefined, assetId: asset?.id });
    setUploadAsset(asset ?? null);
    setUploadOpen(true);
  };

  /* 文件夹上传：webkitdirectory 选中整个目录，目录内文件（含子目录）平铺为独立资产，落在当前目录 */
  const folderInputRef = useRef<HTMLInputElement>(null);
  const onFolderPick = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!list.length || !uppy) return;
    uppy.addFiles(list.map((f) => ({
      data: f,
      name: f.name,
      type: f.type,
      meta: { relPath: (f as any).webkitRelativePath || undefined },
    })));
  };

  useEffect(() => {
    uppyRef.current = uppy;
    return () => { uppy?.destroy(); };
  }, [uppy]);

  /* ---------- 文件夹树 ---------- */
  const treeData: DataNode[] = useMemo(() => {
    const list = folders.data?.folders ?? [];
    const build = (parentId: string | null): DataNode[] =>
      list
        .filter((f) => f.parentId === parentId)
        .map((f) => ({ key: f.id, title: f.name, children: build(f.id) }));
    return [{ key: 'root', title: '全部文件', children: build(null) }];
  }, [folders.data]);

  /* ---------- 操作 ---------- */
  const mkFolder = useMutation({
    mutationFn: (name: string) =>
      api(`/api/projects/${projectId}/folders`, { method: 'POST', body: JSON.stringify({ name, parentId: folderId }) }),
    onSuccess: () => { message.success('已创建'); qc.invalidateQueries({ queryKey: ['folders', projectId] }); },
    onError: (e: any) => message.error(e.message),
  });

  const trashAsset = useMutation({
    mutationFn: (id: string) => api(`/api/assets/${id}/trash`, { method: 'POST' }),
    onSuccess: () => { message.success('已移入回收站'); qc.invalidateQueries({ queryKey: ['assets', projectId] }); },
    onError: (e: any) => message.error(e.message),
  });

  const restoreAsset = useMutation({
    mutationFn: (id: string) => api(`/api/assets/${id}/restore`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets', projectId] }),
  });

  /* 素材改名（上传的视频即剧集，改名 = 改剧集名） */
  const [renameOpen, setRenameOpen] = useState(false);
  const [renaming, setRenaming] = useState<AssetDto | null>(null);
  const [renameForm] = Form.useForm();
  const renameAsset = useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      api(`/api/assets/${v.id}`, { method: 'PATCH', body: JSON.stringify({ name: v.name }) }),
    onSuccess: () => {
      message.success('已重命名');
      setRenameOpen(false);
      qc.invalidateQueries({ queryKey: ['assets', projectId] });
    },
    onError: (e: any) => message.error(e.message),
  });
  const openRename = (a: AssetDto) => {
    setRenaming(a);
    renameForm.setFieldsValue({ name: a.name });
    setRenameOpen(true);
  };

  if (project.isError) return <Forbidden />;

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_: any, a: AssetDto) => (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {a.latestVersion?.hasPoster && (
            <img src={`/api/assets/${a.id}/poster`} style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 4 }} alt="" />
          )}
          <div>
            <Link to={`/p/${projectId}/a/${a.id}${a.latestVersion ? `?v=${a.latestVersion.id}` : ''}`} style={{ color: 'inherit' }}>
              {a.name}
            </Link>
            <div style={{ fontSize: 12, color: '#888' }}>
              v{a.latestVersion?.versionNo ?? 0} · {formatDuration(a.latestVersion?.durationSec)}
              {a.latestVersion?.fpsNum ? ` · ${a.latestVersion.fpsNum}/${a.latestVersion.fpsDen}fps` : ''}
              {a.latestVersion ? ` · ${formatBytes(a.latestVersion.size)}` : ''}
            </div>
          </div>
        </div>
      ),
    },
    {
      title: '状态', dataIndex: ['latestVersion', 'status'], width: 130,
      render: (s: string, a: AssetDto) => {
        const v = a.latestVersion;
        if (!v) return '-';
        if (v.status === 'transcoding' || v.status === 'queued') {
          return <Progress percent={v.progress} size="small" status="active" />;
        }
        if (v.status === 'failed') {
          return <Tooltip title={v.error}><Tag color="error">转码失败</Tag></Tooltip>;
        }
        return <Tag color={VSTATUS_COLOR[v.status]}>{v.status === 'ready' ? '可播放' : v.status === 'unsupported' ? '仅存储' : v.status}</Tag>;
      },
    },
    { title: '审阅', dataIndex: 'reviewStatus', width: 100, render: (s: string) => <Tag color={STATUS_COLOR[s]}>{REVIEW_STATUS_LABEL[s as keyof typeof REVIEW_STATUS_LABEL]}</Tag> },
    { title: '版本', dataIndex: 'versionCount', width: 70 },
    {
      title: '操作', width: 150,
      render: (_: any, a: AssetDto) => (
        /* 表格操作规范：一律 IconAction（图标+tooltip），禁止文字按钮（见 components/IconAction.tsx） */
        <Space>
          {!trash && canEdit && (
            <>
              <IconAction icon={<UploadOutlined />} tooltip="上传新版本" onClick={() => openUpload(a)} />
              <IconAction icon={<EditOutlined />} tooltip="重命名" onClick={() => openRename(a)} />
              <IconAction icon={<DeleteOutlined />} tooltip="移入回收站" danger
                confirm={`将「${a.name}」移入回收站？`}
                onConfirm={() => trashAsset.mutate(a.id)} />
            </>
          )}
          {trash && <IconAction icon={<UndoOutlined />} tooltip="从回收站恢复" onClick={() => restoreAsset.mutate(a.id)} />}
          {a.latestVersion && (
            <Tooltip title="下载原片">
              <a href={`/api/media/${a.latestVersion.id}/original`}>
                <Button size="small" type="text" icon={<DownloadOutlined />} />
              </a>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ width: 240, borderRight: '1px solid #262626', padding: 12, overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <b>{project.data?.project?.name ?? '...'}</b>
          {canEdit && !trash && (
            <Button size="small" type="text" icon={<FolderAddOutlined />} onClick={() => {
              let input = '';
              modal.confirm({
                title: '新建文件夹', content: <Input onChange={(e) => { input = e.target.value; }} placeholder="文件夹名" />,
                onOk: () => mkFolder.mutate(input),
              });
            }} />
          )}
        </div>
        <Tree
          defaultExpandAll
          selectedKeys={[trash ? 'trash' : folderId ?? 'root']}
          treeData={treeData}
          onSelect={(keys) => {
            const k = keys[0];
            setTrash(false);
            setFolderId(k === 'root' || typeof k !== 'string' ? null : k);
          }}
        />
        <div
          style={{ marginTop: 8, padding: '4px 8px', cursor: 'pointer', color: trash ? '#4f7cff' : undefined, borderRadius: 4 }}
          onClick={() => { setTrash(true); setSelected([]); }}
        >
          <RestOutlined /> 回收站
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexShrink: 0, flexWrap: 'wrap' }}>
          {canEdit && !trash && (
            <Button type="primary" icon={<UploadOutlined />} onClick={() => openUpload()}>上传素材</Button>
          )}
          {isManager && <Button icon={<TeamOutlined />} onClick={() => setMembersOpen(true)}>成员</Button>}
          {!trash && (
            <Button
              icon={<DownloadOutlined />}
              disabled={!selected.length}
              href={`/api/projects/${projectId}/download-zip?ids=${selected.join(',')}`}
            >
              批量下载{selected.length ? `(${selected.length})` : ''}
            </Button>
          )}
          <Segmented
            value={view}
            onChange={(v) => setView(v as 'grid' | 'table')}
            options={[
              { value: 'grid', icon: <AppstoreOutlined />, label: '宫格' },
              { value: 'table', icon: <BarsOutlined />, label: '表格' },
            ]}
          />
          <Input
            allowClear prefix={<SearchOutlined />} placeholder="搜索资产名"
            style={{ width: 220, marginLeft: 'auto' }}
            onChange={(e) => {
              if (versionFilterTimer.current) clearTimeout(versionFilterTimer.current);
              versionFilterTimer.current = setTimeout(() => setSearch(e.target.value), 300);
            }}
          />
        </div>

        {/* ---------- 宫格视图：封面卡片 ---------- */}
        {view === 'grid' && (
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
            gap: 14, alignContent: 'start',
          }}>
            {(assets.data?.assets ?? []).map((a) => {
              const v = a.latestVersion;
              const poster = v?.hasPoster ? `/api/assets/${a.id}/poster` : null;
              const isSel = selected.includes(a.id);
              return (
                <Card
                  key={a.id}
                  hoverable
                  styles={{ body: { padding: 10 } }}
                  style={{ border: isSel ? '1px solid #4f7cff' : undefined }}
                  onClick={() => nav(`/p/${projectId}/a/${a.id}${v ? `?v=${v.id}` : ''}`)}
                  cover={
                    <div style={{
                      position: 'relative', height: 118, background: '#1f1f1f',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                    }}>
                      {poster
                        ? <img src={poster} style={{ width: '100%', height: '100%', objectFit: 'contain' }} alt="" />
                        : <FileOutlined style={{ fontSize: 34, color: '#555' }} />}
                      {a.kind === 'video' && v?.status === 'ready' && (
                        <PlayCircleOutlined style={{
                          position: 'absolute', fontSize: 26, color: 'rgba(255,255,255,0.85)',
                          filter: 'drop-shadow(0 1px 3px rgba(0,0,0,.6))',
                        }} />
                      )}
                      {/* 转码中/失败角标 */}
                      {(v?.status === 'transcoding' || v?.status === 'queued') && (
                        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '3px 8px', background: 'rgba(0,0,0,0.65)' }}>
                          <Progress percent={v.progress} size="small" status="active" />
                        </div>
                      )}
                      {v?.status === 'failed' && (
                        <Tooltip title={v.error}>
                          <Tag color="error" style={{ position: 'absolute', left: 6, bottom: 5, marginRight: 0 }}>转码失败</Tag>
                        </Tooltip>
                      )}
                      {v?.status === 'unsupported' && (
                        <Tag color="warning" style={{ position: 'absolute', left: 6, bottom: 5, marginRight: 0 }}>仅存储</Tag>
                      )}
                      {/* 勾选（对齐表格的批量选择） */}
                      <Checkbox
                        checked={isSel}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected((s) => isSel ? s.filter((x) => x !== a.id) : [...s, a.id]);
                        }}
                        style={{ position: 'absolute', top: 6, left: 8, background: 'rgba(0,0,0,0.4)', borderRadius: 3, padding: '1px 5px' }}
                      />
                      {/* 操作栏（对齐表格操作列）：容器统一 stopPropagation，避免点操作时误进审阅页 */}
                      {(canEdit || trash) && (
                        <div
                          style={{
                            position: 'absolute', top: 4, right: 4, display: 'flex', alignItems: 'center',
                            background: 'rgba(0,0,0,0.45)', borderRadius: 4, padding: '0 2px',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {canEdit && !trash && (
                            <>
                              <IconAction icon={<UploadOutlined />} tooltip="上传新版本" onClick={() => openUpload(a)} />
                              <IconAction icon={<EditOutlined />} tooltip="重命名" onClick={() => openRename(a)} />
                              <IconAction icon={<DeleteOutlined />} tooltip="移入回收站" danger
                                confirm={`将「${a.name}」移入回收站？`}
                                onConfirm={() => trashAsset.mutate(a.id)} />
                            </>
                          )}
                          {trash && <IconAction icon={<UndoOutlined />} tooltip="从回收站恢复" onClick={() => restoreAsset.mutate(a.id)} />}
                        </div>
                      )}
                      {/* 时长角标 */}
                      {v?.durationSec != null && v.status === 'ready' && (
                        <span style={{ position: 'absolute', right: 6, bottom: 5, background: 'rgba(0,0,0,0.7)', color: '#eee', fontSize: 11, padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace' }}>
                          {formatDuration(v.durationSec)}
                        </span>
                      )}
                    </div>
                  }
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <Tooltip title={a.name}><span style={{ fontWeight: 500, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span></Tooltip>
                    <Tag color={STATUS_COLOR[a.reviewStatus]} style={{ marginRight: 0 }}>
                      {REVIEW_STATUS_LABEL[a.reviewStatus as keyof typeof REVIEW_STATUS_LABEL]}
                    </Tag>
                  </div>
                  <div style={{ color: '#8c8c8c', fontSize: 12 }}>
                    v{v?.versionNo ?? 0} · {formatBytes(v?.size ?? 0)}
                    {v?.fpsNum ? ` · ${v.fpsNum}/${v.fpsDen}fps` : ''}
                  </div>
                </Card>
              );
            })}
            {(assets.data?.assets ?? []).length === 0 && (
              <div style={{ gridColumn: '1 / -1', padding: '60px 0' }}>
                <Empty description={trash ? '回收站为空' : '暂无素材'} />
              </div>
            )}
          </div>
        )}

        {/* ---------- 表格视图（通用表格组件） ---------- */}
        {view === 'table' && (
          <DataTable<AssetDto>
            rowKey="id"
            data={assets.data?.assets ?? []}
            loading={assets.isPending}
            emptyText={trash ? '回收站为空' : '暂无素材'}
            columns={columns as any}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as string[]),
            }}
          />
        )}
      </div>

      <Modal
        title={uploadAsset ? `上传新版本：${uploadAsset.name}` : '上传素材（断点续传）'}
        open={uploadOpen}
        onCancel={() => {
          // 关弹窗重置：下次打开默认是"新资产"模式，不残留上次"传新版本"的 assetId
          const meta = uppyMeta.get(projectId ?? '');
          if (meta?.assetId) uppyMeta.set(projectId ?? '', { ...meta, assetId: undefined });
          setUploadAsset(null);
          setUploadOpen(false);
        }}
        footer={null}
        width={640}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
          <span style={{ color: '#8c8c8c', fontSize: 12 }}>也可直接拖入整个文件夹：夹内视频（含子目录）平铺为独立剧集</span>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => folderInputRef.current?.click()}>上传文件夹</Button>
        </div>
        {uppy && <UppyDashboardMount uppy={uppy} />}
        <input
          ref={folderInputRef}
          type="file"
          multiple
          hidden
          onChange={onFolderPick}
          {...({ webkitdirectory: '', directory: '' } as any)}
        />
      </Modal>

      {membersOpen && projectId && (
        <MembersDrawer projectId={projectId} onClose={() => setMembersOpen(false)} canManage={isManager} />
      )}

      {/* 素材重命名：上传的视频即剧集，改名就是改剧集名 */}
      <Modal
        title={`重命名：${renaming?.name ?? ''}`}
        open={renameOpen}
        onCancel={() => setRenameOpen(false)}
        onOk={() => renameForm.submit()}
        confirmLoading={renameAsset.isPending}
        okText="保存"
      >
        <Form
          form={renameForm}
          layout="vertical"
          onFinish={(v) => renaming && renameAsset.mutate({ id: renaming.id, name: v.name })}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '名称不能为空' }]}>
            <Input placeholder="例如：第 1 集" onPressEnter={() => renameForm.submit()} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/** @uppy/dashboard v6 是 UIPlugin：以 inline 模式挂到容器 div（否则按 modal 渲染成 display:none），卸载时移除插件 */
function UppyDashboardMount({ uppy }: { uppy: Uppy }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    (uppy as any).use(DashboardPlugin, {
      target: host,
      inline: true,          // 关键：内嵌面板模式；缺省按 modal 渲染且不可见
      theme: 'dark',         // 跟随全站深色主题，不用 uppy 默认白底
      locale: zhCN,          // 面板文案中文化（缺省全英文）
      proudlyDisplayPoweredByUppy: false,
      height: 480,
      width: '100%',
      showProgressDetails: true,
      hideRetryButton: false,
      note: '支持大文件断点续传；上传完成自动转码',
    });
    // uppy 靠 ResizeObserver 首次回调把面板从 opacity 0 翻成可见；弹窗动画/后台标签页等
    // 场景下该回调可能不触发，面板会一直是灰底空白。挂载后主动补一次尺寸与可见状态兜底。
    const kick = setTimeout(() => {
      const plugin = (uppy as any).getPlugin('Dashboard');
      const rect = host.querySelector('.uppy-Dashboard-inner')?.getBoundingClientRect();
      plugin?.setPluginState?.({
        containerWidth: Math.round(rect?.width ?? 0),
        containerHeight: Math.round(rect?.height ?? 0),
        areInsidesReadyToBeVisible: true,
      });
    }, 300);
    return () => {
      clearTimeout(kick);
      const plugin = (uppy as any).getPlugin('Dashboard');
      if (plugin) (uppy as any).removePlugin(plugin as any);
    };
  }, [uppy]);
  return <div ref={hostRef} />;
}

function MembersDrawer({ projectId, onClose, canManage }: { projectId: string; onClose: () => void; canManage: boolean }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const members = useQuery({
    queryKey: ['members', projectId],
    queryFn: () => api<{ members: { userId: string; role: string; name: string; email: string }[] }>(`/api/projects/${projectId}/members`),
  });
  const nonMembers = useQuery({
    queryKey: ['non-members', projectId],
    queryFn: () => api<{ users: { id: string; name: string; email: string }[] }>(`/api/projects/${projectId}/non-members`),
    enabled: canManage,
  });

  const add = useMutation({
    mutationFn: (v: { userId: string; role: string }) =>
      api(`/api/projects/${projectId}/members`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => { message.success('已添加'); qc.invalidateQueries({ queryKey: ['members', projectId] }); qc.invalidateQueries({ queryKey: ['non-members', projectId] }); },
    onError: (e: any) => message.error(e.message),
  });
  const update = useMutation({
    mutationFn: (v: { userId: string; role: string }) =>
      api(`/api/projects/${projectId}/members/${v.userId}`, { method: 'PATCH', body: JSON.stringify({ role: v.role }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['members', projectId] }); },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api(`/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['members', projectId] }); qc.invalidateQueries({ queryKey: ['non-members', projectId] }); },
    onError: (e: any) => message.error(e.message),
  });

  return (
    <Drawer title="项目成员" open onClose={onClose} width={440}>
      <List
        dataSource={members.data?.members ?? []}
        renderItem={(m: any) => (
          <List.Item
            actions={canManage ? [
              <Select
                key="role" size="small" value={m.role} style={{ width: 90 }}
                options={PROJECT_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                onChange={(role) => update.mutate({ userId: m.userId, role })}
              />,
              <Popconfirm key="rm" title="移出项目？" onConfirm={() => remove.mutate(m.userId)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>,
            ] : [<span key="role">{ROLE_LABEL[m.role as ProjectRole]}</span>]}
          >
            <List.Item.Meta
              title={<span>{m.name} {m.title && (
                <Tag color={TITLE_COLOR[m.title as string] ?? 'default'}>{m.title}</Tag>
              )}</span>}
              description={m.email}
            />
          </List.Item>
        )}
      />
      {canManage && (
        <div style={{ marginTop: 16 }}>
          <b>添加成员</b>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Select
              placeholder="选择用户" style={{ flex: 1 }}
              options={(nonMembers.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
              showSearch optionFilterProp="label"
              onSelect={(userId) => add.mutate({ userId, role: 'reviewer' })}
            />
          </div>
        </div>
      )}
    </Drawer>
  );
}
