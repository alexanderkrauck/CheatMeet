/** Own one in-flight request for the mounted meeting, independent of renders. */
export function startInsightRefresh<T>({ read, request, received, thinking, failed }: {
  read: () => string;
  request: (text: string) => Promise<T>;
  received: (value: T) => void;
  thinking: (busy: boolean) => void;
  failed: () => void;
}) {
  let active = true, busy = false, lastAt = -Infinity, lastText = "";
  const tick = async () => {
    const text = read();
    if (!active || busy || text.trim().length < 80 || text === lastText || Date.now() - lastAt < 45000) return;
    busy = true;
    lastAt = Date.now();
    thinking(true);
    try {
      const result = await request(text);
      if (active) {
        lastText = text;
        received(result);
      }
    } catch {
      if (active) failed();
    } finally {
      busy = false;
      if (active) thinking(false);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 5000);
  return () => { active = false; clearInterval(timer); };
}
