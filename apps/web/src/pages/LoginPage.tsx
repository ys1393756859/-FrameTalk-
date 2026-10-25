import { useEffect, useState } from 'react';
import { Form, Input, Button, Card, App, Tabs } from 'antd';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../api';
import type { SessionUser } from '@frametalk/shared';

/**
 * 登录 / 注册双模式页。
 * 注册入口是否显示由后台「安全设置 - 允许自注册」控制（GET /api/auth/register-enabled），
 * 开关关闭时本页只有登录 Tab，注册接口也一并 403。
 */
export default function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { message } = App.useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [registerEnabled, setRegisterEnabled] = useState(false);
  const [minLen, setMinLen] = useState(8);
  const [loginForm] = Form.useForm();
  const [regForm] = Form.useForm();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<{ enabled: boolean; passwordMinLength: number }>('/api/auth/register-enabled')
      .then((r) => { setRegisterEnabled(r.enabled); setMinLen(r.passwordMinLength); })
      .catch(() => {}); // 查不到就当注册关闭
  }, []);

  const afterAuth = (user: SessionUser) => {
    const returnTo = params.get('returnTo') || '/';
    // 整页跳转让 SPA 重新拉取会话；不能用 reload()（会打断本次导航）
    location.href = user.mustChangePassword ? '/change-password' : returnTo;
  };

  /* ---------- 登录 ---------- */
  const onLogin = async (values: { account: string; password: string }) => {
    setLoading(true);
    try {
      const res = await api<{ user: SessionUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      afterAuth(res.user);
    } catch (err: any) {
      message.error(err.message ?? '登录失败');
    } finally {
      setLoading(false);
    }
  };

  /* ---------- 注册 ---------- */
  const onRegister = async (v: { name: string; email?: string; phone?: string; password: string }) => {
    if (!v.email && !v.phone) { message.error('邮箱和手机号至少填一个'); return; }
    setLoading(true);
    try {
      const res = await api<{ user: SessionUser }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ ...v, email: v.email || undefined, phone: v.phone || undefined }),
      });
      message.success('注册成功');
      afterAuth(res.user); // 注册即登录
    } catch (err: any) {
      message.error(err.message ?? '注册失败');
    } finally {
      setLoading(false);
    }
  };

  const pwdRule = { min: minLen, message: `密码至少 ${minLen} 位` };

  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card title="帧言 FrameTalk" style={{ width: 380 }}>
        <Tabs
          activeKey={mode}
          onChange={(k) => setMode(k as 'login' | 'register')}
          items={[
            {
              key: 'login',
              label: '登录',
              children: (
                <Form form={loginForm} layout="vertical" onFinish={onLogin}>
                  <Form.Item name="account" label="账号" rules={[{ required: true }]}>
                    <Input placeholder="邮箱或手机号" autoFocus />
                  </Form.Item>
                  <Form.Item name="password" label="密码" rules={[{ required: true }]}>
                    <Input.Password />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" block loading={loading}>登录</Button>
                </Form>
              ),
            },
            ...(registerEnabled
              ? [{
                  key: 'register',
                  label: '注册',
                  children: (
                    <Form form={regForm} layout="vertical" onFinish={onRegister}>
                      <Form.Item name="name" label="姓名" rules={[{ required: true }]}>
                        <Input placeholder="真实姓名，方便同事找到你" autoFocus />
                      </Form.Item>
                      <Form.Item name="email" label="邮箱" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
                        <Input placeholder="选填，与手机号至少填一个" />
                      </Form.Item>
                      <Form.Item name="phone" label="手机号" rules={[{ pattern: /^1\d{10}$/, message: '11 位手机号' }]}>
                        <Input placeholder="选填" maxLength={11} />
                      </Form.Item>
                      <Form.Item name="password" label="密码" rules={[{ required: true }, pwdRule]}>
                        <Input.Password placeholder={`至少 ${minLen} 位`} />
                      </Form.Item>
                      <Form.Item name="confirm" label="确认密码" dependencies={['password']}
                        rules={[
                          { required: true },
                          ({ getFieldValue }) => ({
                            validator: (_, v) =>
                              !v || v === getFieldValue('password')
                                ? Promise.resolve()
                                : Promise.reject(new Error('两次输入的密码不一致')),
                          }),
                        ]}>
                        <Input.Password />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" block loading={loading}>注册并登录</Button>
                    </Form>
                  ),
                }]
              : []),
          ]}
        />
        {!registerEnabled && (
          <div style={{ color: '#888', fontSize: 12, marginTop: 8 }}>
            本站未开放注册，请联系管理员开通账号
          </div>
        )}
      </Card>
    </div>
  );
}
