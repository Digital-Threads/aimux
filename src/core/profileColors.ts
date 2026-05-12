const PALETTE = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red'] as const;

export function profileColor(name: string | undefined): string | undefined {
  if (!name) return undefined;
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % PALETTE.length;
  return PALETTE[idx];
}
