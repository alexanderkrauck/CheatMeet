import { describe, expect, it, vi } from "vitest";
import { firestoreStore, memoryStore, fileGrantStore, preserveOwnerGoogleGrant, disconnectOwnerGoogleGrant, resolveOwnerGoogleKey, uidGrantKey } from "./tokenStore";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const metadata = () =>
  Response.json({ access_token: "sa-token", expires_in: 3600 });

describe("refresh token store", () => {
  it("treats a missing document as no grant rather than an error", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("metadata")
        ? metadata()
        : new Response("", { status: 404 }),
    );
    const store = firestoreStore({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await store.get("google-1")).toBeNull();
  });

  it("reads the stored refresh token out of the Firestore document shape", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("metadata")
        ? metadata()
        : Response.json({ updateTime:"2026-11-14T01:00:00.000001Z", fields: { refreshToken: { stringValue: "rt" } } }),
    );
    const store = firestoreStore({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await store.get("google-1")).toBe("rt");
  });

  it("tolerates deleting a grant that is already gone", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("metadata")
        ? metadata()
        : String(url).endsWith(":commit") ? Response.json({writeResults:[]}) : new Response("", { status: 404 }),
    );
    const store = firestoreStore({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(store.remove("google-1")).resolves.toBeUndefined();
  });

  it("surfaces a real write failure instead of silently losing the grant", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("metadata")
        ? metadata()
        : new Response("", { status: 500 }),
    );
    const store = firestoreStore({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(store.set("google-1", "rt")).rejects.toThrow(/500/);
  });

  it("keeps a grant per account", async () => {
    const store = memoryStore();
    await store.set("a", "token-a");
    await store.set("b", "token-b");
    await store.remove("a");
    expect(await store.get("a")).toBeNull();
    expect(await store.get("b")).toBe("token-b");
  });

  it("uses one native conditional commit for every read dependency", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async url => String(url).includes("metadata") ? metadata() : Response.json({writeResults:[]}));
    const store = firestoreStore({projectId:"fixture-project",databaseId:"fixture-db",fetchImpl});
    const existing = {key:"G",refreshToken:"R1",version:"2026-11-14T01:00:00.000001Z"};
    const absent = {key:uidGrantKey("A"),refreshToken:null,version:null};
    expect(await store.compare!([existing,absent],[{...absent,refreshToken:"R1",owner:absent.key,subject:"G"}])).toBe(true);
    const [url,init] = fetchImpl.mock.calls.find(([url])=>String(url).endsWith(":commit"))!;
    expect(String(url)).toBe("https://firestore.googleapis.com/v1/projects/fixture-project/databases/fixture-db/documents:commit");
    const body=JSON.parse(String(init!.body));
    expect(body.writes).toHaveLength(2);
    expect(body.writes[0].currentDocument).toEqual({updateTime:existing.version});
    expect(body.writes[1].currentDocument).toEqual({exists:false});
    expect(body.writes[1].update.fields).toMatchObject({refreshToken:{stringValue:"R1"},owner:{stringValue:absent.key},subject:{stringValue:"G"}});
  });

  it("preserves native cutoff metadata and stamps removal at Firestore commit time", async () => {
    const cutoff="2026-11-14T01:00:00.123Z";
    const version="2026-11-14T01:00:01.000001Z";
    const fetchImpl=vi.fn<typeof fetch>(async url=>String(url).includes("metadata")?metadata():String(url).endsWith(":commit")?Response.json({writeResults:[]}):Response.json({updateTime:version,fields:{refreshToken:{nullValue:null},owner:{stringValue:uidGrantKey("A")},subject:{stringValue:"G"},revokedAt:{timestampValue:cutoff}}}));
    const store=firestoreStore({projectId:"fixture-project",fetchImpl});
    const tombstone=await store.read!("G");
    expect(tombstone).toMatchObject({refreshToken:null,revokedAt:Date.parse(cutoff),owner:uidGrantKey("A"),subject:"G"});
    await store.set("G","R1");
    const recreated=JSON.parse(String(fetchImpl.mock.calls.find(([url])=>String(url).endsWith(":commit"))![1]!.body)).writes[0];
    expect(recreated.currentDocument).toEqual({updateTime:version});
    expect(recreated.update.fields.revokedAt).toEqual({timestampValue:cutoff});
    expect(recreated.updateTransforms).toBeUndefined();
    fetchImpl.mockClear();await store.remove("G");
    const removed=JSON.parse(String(fetchImpl.mock.calls.find(([url])=>String(url).endsWith(":commit"))![1]!.body)).writes[0];
    expect(removed.currentDocument).toEqual({updateTime:version});
    expect(removed.update.fields.refreshToken).toEqual({nullValue:null});
    expect(removed.updateTransforms).toEqual([{fieldPath:"revokedAt",setToServerValue:"REQUEST_TIME"}]);
    expect(removed.update.name).toContain("/driveGrants/G");
  });

  it.each([409,412,400])("returns a conflict, not success, for native precondition status %s", async status => {
    const fetchImpl = vi.fn<typeof fetch>(async url=>String(url).includes("metadata") ? metadata() : Response.json({error:{status:"FAILED_PRECONDITION"}},{status}));
    const store=firestoreStore({fetchImpl});
    expect(await store.compare!([{key:"G",refreshToken:"R1",version:"old"}],[{key:"G",refreshToken:null}])).toBe(false);
  });

  it.each(["memory","file"])("%s CAS rejects missing/deleted/recreated generations including same-token ABA", async kind => {
    const root=await mkdtemp(path.join(tmpdir(),"grant-race-"));
    try {
      const store=kind==="file" ? fileGrantStore(root) : memoryStore();
      const missing=await store.read!("G");
      await store.set("G","R1");
      expect(await store.compare!([missing],[{key:"G",refreshToken:"stale"}])).toBe(false);
      const old=await store.read!("G");
      await store.remove("G");
      const tombstone=await store.read!("G");
      expect(tombstone).toMatchObject({refreshToken:null,revokedAt:expect.any(Number)});
      expect(await store.compare!([old],[{key:"G",refreshToken:"resurrected"}])).toBe(false);
      await store.set("G","R1");
      expect((await store.read!("G")).revokedAt).toBe(tombstone.revokedAt);
      expect(await store.compare!([old],[{key:"G",refreshToken:null}])).toBe(false);
      expect(await store.get("G")).toBe("R1");
      if(kind==="file") expect((await fileGrantStore(root).read!("G")).version).toBe((await store.read!("G")).version);
    } finally {await rm(root,{recursive:true,force:true});}
  });

  it.each(["read", "adoption", "conflict", "compare", "get-only"])("R14-S1 refuses readable legacy authority after a %s failure", async failure => {
    const store=memoryStore(); const identity={uid:"A",googleSub:"G"};
    await store.set("G","old-readable");
    if(failure==="conflict"||failure==="compare") {
      await preserveOwnerGoogleGrant(store,identity);
      await disconnectOwnerGoogleGrant(store,identity);
      await store.set("G","new-explicit");
      vi.spyOn(store,"compare").mockImplementation(async()=>{if(failure==="compare")throw Error("store unavailable");return false;});
    } else if(failure!=="get-only") {
      const read=store.read!.bind(store);
      vi.spyOn(store,"read").mockImplementation(async key=>{
        if(key===(failure==="read"?uidGrantKey("A"):"G"))throw Error("store unavailable");
        return read(key);
      });
    }
    const selected=failure==="get-only" ? {get:async(key:string)=>{if(key===uidGrantKey("A"))throw Error("store unavailable");return store.get(key);},set:store.set,remove:store.remove} : store;
    await expect(resolveOwnerGoogleKey(identity,selected)).rejects.toThrow();
    expect(await store.get("G")).toBe(failure==="conflict"||failure==="compare"?"new-explicit":"old-readable");
  });

  it("resolves ordinary legacy readers without CAS fixtures or foreign-alias authority", async () => {
    const identity={uid:"A",googleSub:"G"};const store=memoryStore();
    await store.set("G","legacy");
    expect(await resolveOwnerGoogleKey(identity,store)).toBe("G");
    const legacy={get:store.get,set:store.set,remove:store.remove};
    expect(await resolveOwnerGoogleKey(identity,legacy)).toBe("G");
    await store.set(uidGrantKey("A"),"selected-data");
    expect(await resolveOwnerGoogleKey(identity,legacy)).toBe(uidGrantKey("A"));
    await store.remove(uidGrantKey("A"));
    expect(await resolveOwnerGoogleKey(identity,store)).toBe(uidGrantKey("A"));
    const foreign=memoryStore();await foreign.set("G","other-owner");
    const alias=await foreign.read!("G");
    await foreign.compare!([alias],[{...alias,owner:uidGrantKey("B")}]);
    expect(await resolveOwnerGoogleKey(identity,foreign)).toBe(uidGrantKey("A"));
  });

  it("does not restore a deferred first preservation after revoke", async () => {
    const store=memoryStore(); const identity={uid:"A",googleSub:"G"};
    await store.set("G","R1");
    let entered!:()=>void;let release!:()=>void;
    const pending=new Promise<void>(r=>entered=r);const resume=new Promise<void>(r=>release=r);
    const read=store.read!.bind(store);let paused=false;
    vi.spyOn(store,"read").mockImplementation(async key=>{
      const snapshot=await read(key);
      if(key==="G"&&!paused){paused=true;entered();await resume;}
      return snapshot;
    });
    const preservation=preserveOwnerGoogleGrant(store,identity);
    const rejection=expect(preservation).rejects.toThrow(/inzwischen/);
    await pending;
    expect(await disconnectOwnerGoogleGrant(store,identity)).toEqual(["R1"]);
    release();await rejection;
    expect(await store.get(uidGrantKey("A"))).toBeNull();
    expect(await store.get("G")).toBeNull();
  });
});
