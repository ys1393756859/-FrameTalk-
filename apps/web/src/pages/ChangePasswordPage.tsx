import { Form, Input, Button, Card, App, Alert } from 'antd';
import { api } from '../api';

export default function ChangePasswordPage() {
  const { message } = App.useApp();

  const onFinish = async (v: { oldPassword: string; newPassword: string; confirm: string }) => {
    if (v.newPassword !== v.confirm) return message.error('两次输入不一致');
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: v.oldPassword, newPassword: v.newPassword }),
      });
      message.success('密码已修改');
      location.href = '/';
    } catch (err: any) {
      message.error(err.message);
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card title="修改密码" style={{ width: 400 }}>
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="首次登录或管理员重置后需修改密码" />
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true }]}>
            <Input.Password autoFocus />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="confirm" label="确认新密码" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>确认修改</Button>
        </Form>
      </Card>
    </div>
  );
}
