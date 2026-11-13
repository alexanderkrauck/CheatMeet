import type { Readable } from 'node:stream';
import type { ReportData } from '../../src/types';
import { ProcessingError, type ProcessingIO, type ProcessingJob } from './index';
export type StorageIO = ProcessingIO & {audio(j:ProcessingJob,r:ReportData):Promise<Readable>};
/** Two explicit adapters; a broken Microsoft grant must never select Google. */
export function storageIO(google:StorageIO,microsoft:StorageIO):StorageIO {
  const forJob=(j:Pick<ProcessingJob,'refs'>)=>{
    if(!j.refs.home)return google;
    if(j.refs.home.provider!=='microsoft')throw new ProcessingError(400,'Unbekannter Meeting-Speicherdienst.');
    return microsoft;
  };
  return {
    load:j=>forJob(j).load(j),
    readCheckpoint:(j,n)=>forJob(j).readCheckpoint(j,n),
    checkpoint:(j,n,r)=>forJob(j).checkpoint(j,n,r),
    export:(j,r)=>forJob(j).export(j,r),
    publish:(j,r)=>forJob(j).publish(j,r),
    audio:(j,r)=>forJob(j).audio(j,r),
  };
}
