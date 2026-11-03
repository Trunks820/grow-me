export class CheckError extends Error{constructor(kind,message){super(message);this.kind=kind;}}
export function localUrl(value){
  const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new CheckError('identity','Use the exact http://127.0.0.1:<port> service origin.');
  return url.origin;
}

// Metadata only: heartbeat/work receipts never fetch answers or advance the cursor.
export async function runtimePost({url,sessionId,instanceId,signal},path,body){
  url=localUrl(url);
  for(let attempt=0;attempt<2;attempt++){
    const response=await fetch(url+'/recovery',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(3000)]):AbortSignal.timeout(3000)});
    if(!response.ok)throw Error('Cannot read runtime identity');
    const meta=await response.json();
    if(meta.session_id!==sessionId||!meta.instance_id||response.headers.get('x-grow-me-instance')!==meta.instance_id||instanceId&&instanceId!==meta.instance_id)throw new CheckError('identity','Runtime identity changed; run check.mjs before resuming.');
    const result=await fetch(url+path,{method:'POST',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(3000)]):AbortSignal.timeout(3000),headers:{'content-type':'application/json'},body:JSON.stringify({...body,expected_session_id:sessionId,expected_revision:meta.revision,expected_instance_id:meta.instance_id})});
    if(result.status===409&&attempt===0)continue;
    const data=await result.json();if(!result.ok)throw Error(data.error??'Runtime receipt failed');
    if(result.headers.get('x-grow-me-instance')!==meta.instance_id)throw new CheckError('identity','Runtime instance changed');
    return{...data,instance_id:meta.instance_id};
  }
}
