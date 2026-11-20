// Only operational messages pass here. Interview answers always retain their original text.
export function assistantSilenceSeconds(ai) {
  return (
    ai?.seconds_since_last_check ??
    ai?.seconds_since_last_heartbeat ??
    ai?.seconds_since_last_work ??
    null
  );
}
export function assistantConnection(ai, openedForMs) {
  if (ai?.heartbeat_active || ai?.work_active) return 'connected';
  const silence = assistantSilenceSeconds(ai);
  if (silence === null) return 'connecting';
  return silence * 1000 > (ai.short_query_timeout_ms ?? ai.timeout_ms) &&
    openedForMs > ai.timeout_ms
    ? 'paused'
    : 'connected';
}
export function publicError(value, fallback = '连接或生成暂时遇到问题，请重试。') {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (
    !text ||
    text.length > 180 ||
    /[\r\n]/.test(text) ||
    /(?:^|\s)(?:event|data):|[{}<>]|stack\s*trace|\bat\s+\S+\s*\(/i.test(text)
  )
    return fallback;
  return text;
}
