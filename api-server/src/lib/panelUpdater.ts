const updaters = new Map<string, ReturnType<typeof setInterval>>();

export function startPanelUpdater(guildId: string, fn: () => void, ms = 5000): void {
  stopPanelUpdater(guildId);
  const id = setInterval(fn, ms);
  updaters.set(guildId, id);
}

export function stopPanelUpdater(guildId: string): void {
  const id = updaters.get(guildId);
  if (id !== undefined) {
    clearInterval(id);
    updaters.delete(guildId);
  }
}
