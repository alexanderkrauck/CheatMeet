import { describe, expect, it } from 'vitest';
import { microsoftHome, reportIndexCollection, archiveFolderLink } from '../shared/storage';

describe('provider-bound meeting home', () => {
  it('admits explicit Microsoft references without a Google fallback', () => {
    const home = {provider:'microsoft',connectionId:'account-1',driveId:'b!opaque',rootId:'root',rootName:'Meetings',folderId:'folder',reportId:'report'};
    expect(microsoftHome(home)).toEqual(home);
    expect(reportIndexCollection({home})).toBe('meetings');
    expect(reportIndexCollection({})).toBe('reports');
  });
  it('rejects URLs, capabilities and malformed homes instead of silently selecting Google', () => {
    expect(() => microsoftHome({provider:'microsoft',connectionId:'x',driveId:'https://evil.test',rootId:'r',rootName:'Meetings'})).toThrow();
    expect(() => microsoftHome({provider:'microsoft',connectionId:'x',driveId:'d',rootId:'r',rootName:'Meetings',uploadUrl:'https://secret.test'})).toThrow();
  });
  it('builds only public archive links, never capability URLs', () => {
    expect(archiveFolderLink({driveFolderId:'legacy'})).toBe('https://drive.google.com/drive/folders/legacy');
    expect(archiveFolderLink({home:{provider:'microsoft',connectionId:'c',driveId:'d',rootId:'r',rootName:'M',webUrl:'https://example.sharepoint.com/personal/a/Documents/Meetings'}})).toContain('sharepoint.com');
    expect(archiveFolderLink({home:{provider:'microsoft',connectionId:'c',driveId:'d',rootId:'r',rootName:'M',webUrl:'javascript:alert(1)'}})).toBeUndefined();
  });
  it('accepts personal OneDrive navigation IDs but not sharing capabilities',()=>{
    const home={provider:'microsoft' as const,connectionId:'c',driveId:'d',rootId:'r',rootName:'M',webUrl:'https://onedrive.live.com/?cid=ABC&id=ABC%21123'};
    expect(microsoftHome(home)).toEqual(home);
    expect(archiveFolderLink(home&&{home})).toBe(home.webUrl);
    expect(()=>microsoftHome({...home,webUrl:home.webUrl+'&authkey=secret'})).toThrow();
  });
});
