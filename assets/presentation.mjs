// Only operational messages pass here. Interview answers always retain their original text.
export function publicError(value,fallback='连接或生成暂时遇到问题，请重试。'){
  if(typeof value!=='string')return fallback;
  const text=value.trim();
  if(!text||text.length>180||/[\r\n]/.test(text)||/(?:^|\s)(?:event|data):|[{}<>]|stack\s*trace|\bat\s+\S+\s*\(/i.test(text))return fallback;
  return text;
}
