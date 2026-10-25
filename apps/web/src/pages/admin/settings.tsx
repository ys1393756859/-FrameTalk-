import { useEffect, useState } from 'react';
import {
  App, Button, Card, Form, Input, InputNumber, Select, Switch, Tabs, Tag, Space, Alert, Popconfirm, Tooltip,
} from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { SECRET_KEEP, USER_TITLES } from '@frametalk/shared';

/**
 * 系统设置：分组 Tab（存储/站点/安全/转码/飞书通知）。
 * 新增分组 = packages/shared settings.ts 注册 schema，这里加一个 Tab。
 */
export default function AdminSettings() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [active, setActive] = useState('storage');

  const data = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<{ groups: Record<string, any>; labels: Record<string, string> }>('/api/admin/settings'),
  });

  const save = useMutation({
    mutationFn: ({ group, values }: { group: string; values: Record<string, unknown> }) =>
      api(`/api/admin/settings/${group}`, { method: 'PUT', body: JSON.stringify(values) }),
    onSuccess: () => { message.success('已保存，即时生效'); qc.invalidateQueries({ queryKey: ['admin-settings'] }); },
    onError: (e: any) => message.error(e.message),
  });

  const testStorage = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>('/api/admin/settings/storage/test', { method: 'POST' }),
    onSuccess: (r) => r.ok ? message.success(r.message) : message.error(r.message),
    onError: (e: any) => message.error(e.message),
  });

  const testFeishu = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>('/api/admin/settings/feishu/test', { method: 'POST' }),
    onSuccess: (r) => r.ok ? message.success(r.message) : message.error(r.message),
    onError: (e: any) => message.error(e.message),
  });

  if (data.isPending) return <div style={{ padding: 24 }}>加载中...</div>;
  const groups = data.data?.groups ?? {};
  const labels = data.data?.labels ?? {};

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20, maxWidth: 860, width: '100%', margin: '0 auto' }}>
      <h3 style={{ marginBottom: 4 }}>系统设置</h3>
      <div style={{ color: '#888', marginBottom: 16 }}>修改后即时生效，无需重启服务；配置持久化在数据库。</div>
      <Tabs
        activeKey={active}
        onChange={setActive}
        items={[
          { key: 'storage', label: labels.storage ?? '存储', children: <StorageTab group={groups.storage} saving={save.isPending} onSave={(v: any) => save.mutate({ group: 'storage', values: v })} onTest={() => testStorage.mutate()} testing={testStorage.isPending} /> },
          { key: 'general', label: labels.general ?? '站点', children: <GeneralTab group={groups.general} saving={save.isPending} onSave={(v: any) => save.mutate({ group: 'general', values: v })} /> },
          { key: 'security', label: labels.security ?? '安全', children: <SecurityTab group={groups.security} saving={save.isPending} onSave={(v: any) => save.mutate({ group: 'security', values: v })} /> },
          { key: 'transcode', label: labels.transcode ?? '转码', children: <TranscodeTab group={groups.transcode} saving={save.isPending} onSave={(v: any) => save.mutate({ group: 'transcode', values: v })} /> },
          { key: 'feishu', label: labels.feishu ?? '飞书通知', children: <FeishuTab group={groups.feishu} saving={save.isPending} onSave={(v: any) => save.mutate({ group: 'feishu', values: v })} onTest={() => testFeishu.mutate()} testing={testFeishu.isPending} /> },
        ]}
      />
    </div>
  );
}

function SecretInput({ value, onChange, isSet, placeholder }: {
  value?: string; onChange?: (v: any) => void; isSet?: boolean; placeholder?: string;
}) {
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      <Input.Password
        value={value && value !== SECRET_KEEP ? value : ''}
        onChange={onChange}
        placeholder={isSet ? '已设置，留空保持不变' : placeholder}
        autoComplete="new-password"
      />
      {isSet && !value && <Tag color="green" style={{ width: 'fit-content' }}>已配置（留空 = 不修改）</Tag>}
    </Space>
  );
}

/** 带 ? 的字段标签：长说明收进 Tooltip，页面不堆文本 */
function TipLabel({ text, tip }: { text: string; tip: string }) {
  return (
    <Space size={4}>
      {text}
      <Tooltip title={tip}>
        <QuestionCircleOutlined style={{ color: '#888', cursor: 'help', fontSize: 13 }} />
      </Tooltip>
    </Space>
  );
}

const GRID2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 16 } as const;
const MB = { marginBottom: 12 } as const;

function StorageTab({ group, onSave, saving, onTest, testing }: any) {
  const [form] = Form.useForm();
  useEffect(() => { if (group) form.setFieldsValue(group); }, [group]);
  const backend = Form.useWatch('backend', form) ?? 'local';
  return (
    <Form form={form} layout="vertical" onFinish={onSave} style={{ maxWidth: 640 }}>
      <Form.Item name="backend" rules={[{ required: true }]} style={MB}
        label={<TipLabel text="原片归档后端" tip="代理/封面/雪碧图/波形始终存本地保证播放性能；仅原片转码完成后归档远端，下载/重试时自动回源。" />}>
        <Select options={[
          { value: 'local', label: '本地媒体盘（默认）' },
          { value: 'webdav', label: 'WebDAV' },
          { value: 'ftp', label: 'FTP' },
        ]} />
      </Form.Item>

      {backend === 'webdav' && (
        <>
          <div style={GRID2}>
            <Form.Item name="webdavBaseUrl" label="WebDAV 地址" rules={[{ required: true, message: '必填' }]} style={MB}>
              <Input placeholder="http://nas.local:5005/dav" />
            </Form.Item>
            <Form.Item name="webdavUsername" label="用户名" style={MB}>
              <Input autoComplete="off" />
            </Form.Item>
          </div>
          <Form.Item name="webdavPassword" label="密码" style={MB}>
            <SecretInput isSet={group?.webdavPasswordSet} placeholder="WebDAV 密码" />
          </Form.Item>
        </>
      )}

      {backend === 'ftp' && (
        <>
          <div style={GRID2}>
            <Form.Item name="ftpHost" label="FTP 主机" rules={[{ required: true, message: '必填' }]} style={MB}>
              <Input placeholder="nas.local" />
            </Form.Item>
            <Form.Item name="ftpPort" label={<TipLabel text="端口" tip="FTP / 显式 FTPS 默认 21。" />} initialValue={21} style={MB}>
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <div style={GRID2}>
            <Form.Item name="ftpUser" label="用户名" style={MB}>
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item name="ftpPassword" label="密码" style={MB}>
              <SecretInput isSet={group?.ftpPasswordSet} placeholder="FTP 密码" />
            </Form.Item>
          </div>
          <Form.Item style={MB}>
            <Space size={8}>
              <TipLabel text="FTPS（显式加密）" tip="服务端支持显式 TLS（AUTH TLS）时开启；普通 FTP 保持关闭。" />
              <Form.Item name="ftpSecure" valuePropName="checked" noStyle><Switch /></Form.Item>
            </Space>
          </Form.Item>
        </>
      )}

      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
        {backend !== 'local' && (
          <Popconfirm title="用当前已保存的配置测试连接？" onConfirm={onTest}>
            <Button loading={testing}>测试连接</Button>
          </Popconfirm>
        )}
      </Space>
    </Form>
  );
}

function GeneralTab({ group, onSave, saving }: any) {
  const [form] = Form.useForm();
  useEffect(() => { if (group) form.setFieldsValue(group); }, [group]);
  return (
    <Form form={form} layout="vertical" onFinish={onSave} style={{ maxWidth: 640 }}>
      <Form.Item name="siteName" label="站点名称" rules={[{ required: true }]} style={MB}>
        <Input maxLength={50} placeholder="帧言 FrameTalk" />
      </Form.Item>
      <div style={GRID2}>
        <Form.Item name="maxUploadGb" label={<TipLabel text="单文件上传上限（GB）" tip="0 = 不限；超出上限的文件在上传时被拒绝（413）。" />} style={MB}>
          <InputNumber min={0} max={2048} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="tmpRetentionHours" label={<TipLabel text="未完成上传保留（小时）" tip="断点续传的临时分片保留时长，超时未完成则自动清理释放磁盘。" />} style={MB}>
          <InputNumber min={1} max={720} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <div style={GRID2}>
        <Form.Item name="trashRetentionDays" label={<TipLabel text="回收站保留（天）" tip="移入回收站的素材保留天数，到期由后台任务彻底删除。" />} style={MB}>
          <InputNumber min={1} max={365} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="diskWarnPercent" label={<TipLabel text="磁盘剩余告警阈值（%）" tip="媒体盘剩余空间低于该比例时，页面顶部显示存储告警。" />} style={MB}>
          <InputNumber min={1} max={99} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
    </Form>
  );
}

function SecurityTab({ group, onSave, saving }: any) {
  const [form] = Form.useForm();
  useEffect(() => { if (group) form.setFieldsValue(group); }, [group]);
  return (
    <Form form={form} layout="vertical" onFinish={onSave} style={{ maxWidth: 640 }}>
      <div style={GRID2}>
        <Form.Item name="sessionDays" label={<TipLabel text="会话有效期（天）" tip="登录后保持免登录的天数，到期需重新登录；修改后对新登录生效。" />} style={MB}>
          <InputNumber min={1} max={90} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="passwordMinLength" label={<TipLabel text="密码最小长度" tip="注册、修改密码时要求的最小位数。" />} style={MB}>
          <InputNumber min={8} max={64} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <div style={GRID2}>
        <Form.Item name="loginFailLimit" label={<TipLabel text="登录失败锁定阈值（次）" tip="同一账号连续输错密码达到该次数后临时锁定；成功登录会清零计数。" />} style={MB}>
          <InputNumber min={1} max={100} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="loginLockMinutes" label={<TipLabel text="锁定时长（分钟）" tip="触发锁定后需等待的分钟数，到期自动解锁。" />} style={MB}>
          <InputNumber min={1} max={1440} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <Form.Item style={MB}>
        <Space size={8}>
          <TipLabel text="允许自注册" tip="开启后登录页显示注册入口，新用户可自行注册（无项目权限，需管理员拉入项目）。" />
          <Form.Item name="allowSelfRegister" valuePropName="checked" noStyle><Switch /></Form.Item>
        </Space>
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
    </Form>
  );
}

function TranscodeTab({ group, onSave, saving }: any) {
  const [form] = Form.useForm();
  useEffect(() => { if (group) form.setFieldsValue(group); }, [group]);
  return (
    <Form form={form} layout="vertical" onFinish={onSave} style={{ maxWidth: 640 }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="1080p CRF20 已足够审片；服务器转码吃力时可调快预设（如 veryfast），画质略降速度约翻倍。" />
      <div style={GRID2}>
        <Form.Item name="crf" label={<TipLabel text="CRF" tip="x264 恒定质量因子（14-28），越小画质越高、文件越大；审片推荐 20。" />} style={MB}>
          <InputNumber min={14} max={28} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="maxRateMbps" label={<TipLabel text="码率上限（Mbps）" tip="代理视频码率峰值，防止高动态画面下文件过大。" />} style={MB}>
          <InputNumber min={2} max={60} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <div style={GRID2}>
        <Form.Item name="preset" label={<TipLabel text="x264 预设" tip="越慢压缩效率越高、越吃 CPU；medium 均衡，veryfast 速度约翻倍。" />} style={MB}>
          <Select options={['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map((p) => ({ value: p, label: p }))} />
        </Form.Item>
        <Form.Item name="maxLongSidePx" label={<TipLabel text="代理长边上限（px）" tip="代理视频长边缩放上限，小分辨率源不放大；0 = 默认 1920。" />} style={MB}>
          <InputNumber min={0} max={3840} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <div style={GRID2}>
        <Form.Item name="retryLimit" label={<TipLabel text="失败自动重试次数" tip="转码失败后自动重试的次数；0 = 不重试。" />} style={MB}>
          <InputNumber min={0} max={10} style={{ width: '100%' }} />
        </Form.Item>
        <div />
      </div>
      <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
    </Form>
  );
}

/** 免打扰时间下拉：半小时粒度 HH:mm */
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const v = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
  return { value: v, label: v };
});

function FeishuTab({ group, onSave, saving, onTest, testing }: any) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  useEffect(() => { if (group) form.setFieldsValue(group); }, [group]);
  const enabled = Form.useWatch('enabled', form);
  const [chats, setChats] = useState<Array<{ chat_id: string; name: string }> | null>(null);
  const [chatsLoading, setChatsLoading] = useState(false);

  const fetchChats = async () => {
    setChatsLoading(true);
    try {
      const r = await api<{ ok: boolean; message?: string; chats?: Array<{ chat_id: string; name: string }> }>('/api/admin/settings/feishu/chats');
      if (r.ok) {
        setChats(r.chats ?? []);
        if (!(r.chats ?? []).length) message.warning('机器人未加入任何群，或缺少 im:chat 只读权限');
      } else {
        setChats(null);
        message.error(r.message ?? '获取群列表失败');
      }
    } catch (e: any) {
      setChats(null);
      message.error(e.message);
    } finally {
      setChatsLoading(false);
    }
  };

  return (
    <Form form={form} layout="vertical" onFinish={onSave} style={{ maxWidth: 640 }}>
      <Form.Item style={MB}>
        <Space size={8}>
          <TipLabel text="启用飞书通知" tip="服务端直连飞书开放平台（无需中转服务），双通道投递：顶层评论 = 群卡片 @ 项目成员 + 逐人私信；线程回复 = 仅私信相关人（不进群）；@ 谁就私信谁。两通道独立容错，一个失败不影响另一个。按成员手机号/邮箱匹配飞书账号。部署机只需能出站访问 open.feishu.cn，无需公网 IP / 入站端口。" />
          <Form.Item name="enabled" valuePropName="checked" noStyle><Switch /></Form.Item>
        </Space>
      </Form.Item>
      <div style={GRID2}>
        <Form.Item name="appId" label={<TipLabel text="飞书 App ID" tip="企业自建应用凭证：飞书开放平台 → 应用 → 凭证与基础信息（cli_ 开头）。" />} style={MB}>
          <Input placeholder="cli_xxxxxxxx" disabled={!enabled} />
        </Form.Item>
        <Form.Item name="appSecret" label={<TipLabel text="飞书 App Secret" tip="需开通权限：contact:user.id:readonly（手机号/邮箱转 ID）、im:message（发消息）、im:chat:readonly（拉群列表）；通讯录数据范围须覆盖项目成员。" />} style={MB}>
          <SecretInput isSet={group?.appSecretSet} placeholder="首次配置时填写" />
        </Form.Item>
      </div>
      <Form.Item style={MB}
        label={<TipLabel text="目标群 chat_id" tip="oc_ 开头；机器人须已拉进该群。保存 App ID/Secret 后点「获取群列表」，从机器人已加入的群中直接选择。" />}>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="chatId" noStyle>
            <Input placeholder="oc_xxxxxxxx" disabled={!enabled} />
          </Form.Item>
          <Button onClick={fetchChats} loading={chatsLoading} disabled={!enabled}>获取群列表</Button>
        </Space.Compact>
        {chats && chats.length > 0 && (
          <Select
            style={{ width: '100%', marginTop: 8 }}
            placeholder="从机器人已加入的群中选择"
            options={chats.map((c) => ({ value: c.chat_id, label: `${c.name}（${c.chat_id}）` }))}
            onChange={(v) => form.setFieldsValue({ chatId: v })}
          />
        )}
      </Form.Item>
      <Form.Item name="platformUrl" style={MB}
        label={<TipLabel text="平台访问地址" tip="帧言的内网地址，用于卡片里「去帧言查看与回复」跳转按钮，如 http://192.168.1.10:3000；留空则不显示按钮。" />}>
        <Input placeholder="http://192.168.1.10:3000" disabled={!enabled} />
      </Form.Item>
      <div style={GRID2}>
        <Form.Item name="windowMinutes" label={<TipLabel text="聚合窗口（分钟）" tip="窗口内同一项目的评论合并为一条 @ 摘要再发，越大越安静、越不及时。" />} style={MB}>
          <InputNumber min={1} max={180} style={{ width: '100%' }} disabled={!enabled} />
        </Form.Item>
        <Form.Item name="dailyMax" label={<TipLabel text="每日 @ 消息上限" tip="每项目每天最多发几条群通知，0 = 不限；超出的摘要丢弃并记日志（站内通知不受影响）。" />} style={MB}>
          <InputNumber min={0} max={200} style={{ width: '100%' }} disabled={!enabled} />
        </Form.Item>
      </div>
      <div style={GRID2}>
        <Form.Item name="quietStart" label={<TipLabel text="免打扰开始" tip="开始/结束都填才生效，支持跨午夜；期间不发，攒到免打扰结束合并成一条补发。" />} style={MB}>
          <Select options={TIME_OPTIONS} allowClear placeholder="不启用" disabled={!enabled} />
        </Form.Item>
        <Form.Item name="quietEnd" label="免打扰结束" style={MB}>
          <Select options={TIME_OPTIONS} allowClear placeholder="不启用" disabled={!enabled} />
        </Form.Item>
      </div>
      <div style={GRID2}>
        <Form.Item style={MB}>
          <Space size={8}>
            <TipLabel text="显式 @提及 立即发送" tip="评论里 @ 了具体成员时视为紧急，绕过聚合窗口立即发送（线程回复本身就会立即私信，不受此开关影响）；两条消息仍保持最小 30 秒间隔防刷屏。" />
            <Form.Item name="mentionBypass" valuePropName="checked" noStyle><Switch disabled={!enabled} /></Form.Item>
          </Space>
        </Form.Item>
        <Form.Item style={MB}>
          <Space size={8}>
            <TipLabel text="@ 名单包含评论作者" tip="默认关闭：不 @ 发评论的人自己。" />
            <Form.Item name="atAuthor" valuePropName="checked" noStyle><Switch disabled={!enabled} /></Form.Item>
          </Space>
        </Form.Item>
      </div>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
        <Popconfirm title="先保存配置，再向目标群发一条测试卡片（不 @ 人）？" onConfirm={onTest}>
          <Button loading={testing}>测试</Button>
        </Popconfirm>
      </Space>
    </Form>
  );
}
