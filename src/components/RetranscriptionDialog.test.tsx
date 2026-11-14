import React from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReportData } from "../types";
const h=vi.hoisted(()=>({slots:[] as any[],cursor:0,effects:[] as (()=>unknown)[],check:vi.fn()}));
vi.mock("react",async load=>({...await load<typeof import("react")>(),
  useRef:(value:any)=>h.slots[h.cursor++]??=( {current:value} ),
  useState:(value:any)=>{const i=h.cursor++;if(!(i in h.slots))h.slots[i]=value;return [h.slots[i],(next:any)=>{h.slots[i]=typeof next==="function"?next(h.slots[i]):next;}];},
  useEffect:(fn:()=>unknown,deps:any[])=>{const i=h.cursor++;if(!h.slots[i]||deps.some((v,j)=>v!==h.slots[i][j])){h.slots[i]=deps;h.effects.push(fn);}},
}));
vi.mock("react-dom",()=>({createPortal:(node:unknown)=>node}));
vi.mock("../lib/serverProcessing",()=>({getServerRetranscription:h.check}));
import RetranscriptionDialog from "./RetranscriptionDialog";
const report={id:"qa",title:"Pinned meeting",updatedAt:"original"} as ReportData;
const confirm=vi.fn(async()=>{});
function nodes(tree:any):any[]{return Array.isArray(tree)?tree.flatMap(nodes):React.isValidElement(tree)?[tree,...nodes((tree as any).props.children)]:[];}
function view(){h.cursor=0;return RetranscriptionDialog({report,title:report.title,onClose:()=>{},onConfirm:confirm} as any);}
function paid(){return nodes(view()).find(n=>n.type==="button"&&n.props.className.includes("btn-primary"));}
async function flush(){for(const fn of h.effects.splice(0))fn();for(let i=0;i<6;i++)await Promise.resolve();}
beforeEach(()=>{h.slots=[];h.cursor=0;h.effects=[];vi.clearAllMocks();vi.stubGlobal("document",{body:{}});});
it("checks native eligibility before enabling paid confirmation",async()=>{
  h.check.mockResolvedValue({state:"available",message:"One reserved pass available"});
  expect(paid().props.disabled).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  await flush();
  expect(h.check).toHaveBeenCalledWith(report);
  expect(paid().props.disabled).toBe(false);
  await paid().props.onClick();
  expect(confirm).toHaveBeenCalledOnce();
});
it.each(["used","uncertain","busy","missing-audio","unavailable"])("does not allow a paid start when eligibility is %s",async state=>{
  h.check.mockResolvedValue({state,message:"No new paid submission"});
  view();await flush();
  expect(paid().props.disabled).toBe(true);
  await paid().props.onClick();
  expect(confirm).not.toHaveBeenCalled();
});
