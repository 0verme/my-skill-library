async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy selection-based copy for restricted contexts.
    }
  }

  const temporaryInput = document.createElement('textarea');
  temporaryInput.value = text;
  temporaryInput.setAttribute('readonly', '');
  temporaryInput.style.position = 'fixed';
  temporaryInput.style.opacity = '0';
  document.body.append(temporaryInput);
  temporaryInput.select();

  try {
    const legacyExec = Reflect.get(document, 'execCommand') as
      ((command: string) => boolean) | undefined;
    return legacyExec?.call(document, 'copy') ?? false;
  } catch {
    return false;
  } finally {
    temporaryInput.remove();
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-target]')) {
  button.addEventListener('click', async () => {
    const targetId = button.dataset.copyTarget;
    const target = targetId ? document.getElementById(targetId) : null;
    const status = button
      .closest<HTMLElement>('.prompt-panel')
      ?.querySelector<HTMLElement>('[data-copy-status]');
    if (!target || !status) return;

    const wasCopied = await copyToClipboard(target.textContent ?? '');
    status.textContent = wasCopied ? '已复制到剪贴板' : '复制未成功，请手动选择文本';
    status.style.color = wasCopied ? '' : '#a14444';
    button.setAttribute('aria-label', wasCopied ? '已复制' : '复制失败，请手动选择文本');
  });
}
