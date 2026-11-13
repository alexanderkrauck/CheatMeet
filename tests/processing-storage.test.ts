import {expect,it,vi} from 'vitest';
import {storageIO} from '../server/processing/storage';
import type {ProcessingJob,ProcessingIO} from '../server/processing';
const adapter=()=>({load:vi.fn(),readCheckpoint:vi.fn(),checkpoint:vi.fn(),export:vi.fn(),publish:vi.fn(),audio:vi.fn()});
it('routes every operation through the pinned Microsoft home and never falls back to Google',async()=>{
  const google=adapter(), microsoft=adapter();
  const io=storageIO(google as any,microsoft as any);
  const j={refs:{home:{provider:'microsoft'}}} as ProcessingJob;
  await io.load(j);await io.readCheckpoint(j,'prepared');await io.checkpoint(j,'prepared',{} as any);await io.export(j,{} as any);await io.publish(j,{} as any);await io.audio(j,{} as any);
  for(const name of ['load','readCheckpoint','checkpoint','export','publish','audio'] as const){expect(microsoft[name]).toHaveBeenCalledTimes(1);expect(google[name]).not.toHaveBeenCalled();}
  microsoft.load.mockRejectedValueOnce(Error('OneDrive unavailable'));
  await expect(io.load(j)).rejects.toThrow('OneDrive unavailable');
  expect(google.load).not.toHaveBeenCalled();
});
