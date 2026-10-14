function revealMediaFallback(media: HTMLElement) {
  media.hidden = true;
  const frame = media.closest<HTMLElement>('[data-media-frame]');
  const fallback = frame?.querySelector<HTMLElement>('[data-image-fallback]');
  if (fallback) fallback.hidden = false;
}

for (const image of document.querySelectorAll<HTMLImageElement>('[data-fallback-image]')) {
  image.addEventListener('error', () => revealMediaFallback(image), { once: true });
  if (image.complete && image.naturalWidth === 0) revealMediaFallback(image);
}

for (const video of document.querySelectorAll<HTMLVideoElement>('[data-fallback-video]')) {
  video.addEventListener('error', () => revealMediaFallback(video), { once: true });
}
