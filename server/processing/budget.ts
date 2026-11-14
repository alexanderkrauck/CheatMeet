import { AsyncLocalStorage } from 'node:async_hooks';
/** A whole worker step has one budget, not a fresh timeout for every REST call.
 * Abort is awaited by the owner: never race a background paid request and return. */
const budget = new AsyncLocalStorage<{deadline:number;signal:AbortSignal}>();
export function withProcessingBudget<T>(ms:number,run:()=>Promise<T>):Promise<T> {
  return budget.run({deadline:Date.now()+ms,signal:AbortSignal.timeout(ms)},run);
}
/** Return to the outer budget with time left for the durable result checkpoint. */
export function withProcessingHeadroom<T>(reserveMs:number,run:()=>Promise<T>):Promise<T> {
  const b=budget.getStore();
  if(!b)return run();
  const ms=b.deadline-Date.now()-reserveMs;
  if(ms<=0)return Promise.reject(new DOMException('Verarbeitungszeit überschritten.','TimeoutError'));
  return budget.run({deadline:b.deadline-reserveMs,signal:AbortSignal.any([b.signal,AbortSignal.timeout(ms)])},run);
}
export const processingSignal=()=>budget.getStore()?.signal;
export function remainingProcessingMs(cap=120000) {
  const b=budget.getStore();
  b?.signal.throwIfAborted();
  if(b&&b.deadline<=Date.now())throw new DOMException('Verarbeitungszeit überschritten.','TimeoutError');
  return Math.max(1,Math.min(cap,b?b.deadline-Date.now():cap));
}
export const boundedFetch:typeof fetch=(input,init:RequestInit={})=>{
  const b=budget.getStore();
  if(!b)return fetch(input,init);
  b.signal.throwIfAborted();
  return fetch(input,{...init,signal:init.signal?AbortSignal.any([b.signal,init.signal]):b.signal});
};
