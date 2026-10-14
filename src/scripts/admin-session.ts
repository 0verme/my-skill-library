const sessionStatus = document.querySelector<HTMLElement>('[data-admin-session]');

if (sessionStatus) {
  try {
    const response = await fetch('/api/admin/session', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (response.ok) {
      const session: unknown = await response.json();
      if (
        session &&
        typeof session === 'object' &&
        'authenticated' in session &&
        session.authenticated === true &&
        'email' in session &&
        typeof session.email === 'string'
      ) {
        sessionStatus.textContent = `已通过 Worker 服务端身份验证：${session.email}`;
      } else {
        sessionStatus.textContent = '后台会话响应无效，已停止加载受保护操作。';
      }
    } else if (response.status === 401) {
      sessionStatus.textContent = '请先通过 Cloudflare Access 身份验证。';
    } else if (response.status === 403) {
      sessionStatus.textContent = '当前身份未获管理员授权。';
    } else if (response.status === 503) {
      sessionStatus.textContent = '后台鉴权配置尚未完成，服务端已安全拒绝访问。';
    } else {
      sessionStatus.textContent = '后台会话暂不可用；没有开放写入操作。';
    }
  } catch {
    sessionStatus.textContent = '无法连接后台鉴权服务；没有开放写入操作。';
  }
}

export {};
