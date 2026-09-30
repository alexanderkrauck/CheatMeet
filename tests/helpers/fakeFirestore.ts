/**
 * A small in-memory stand-in for the Firestore REST API, faithful in the ways
 * the code under test depends on: preconditions (`exists`, `updateTime`) and the
 * status codes real Firestore uses when they fail, plus owner queries.
 */
export interface FakeDoc {
  fields: Record<string, any>;
  updateTime: string;
}
export function fakeFirestore(options: { alwaysConflict?: boolean; failWith?: number } = {}) {
  const documents = new Map<string, FakeDoc>();
  let clock = 0;
  const nextTime = () => new Date(Date.UTC(2030, 0, 1, 0, 0, 0, ++clock)).toISOString();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const key = (url: URL) =>
    decodeURIComponent(url.pathname.replace(/^\/v1\//, "").replace(/:runQuery$/, ""));

  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (options.failWith) return json(options.failWith, { error: { message: "boom" } });
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method || "GET").toUpperCase();

    if (url.pathname.endsWith(":runQuery")) {
      const query = JSON.parse(String(init.body)).structuredQuery;
      const parent = key(url);
      const collection = query.from[0].collectionId;
      const filter = query.where?.fieldFilter;
      const rows = [...documents.entries()]
        .filter(([name]) => name.startsWith(`${parent}/${collection}/`) && !name.slice(parent.length + collection.length + 2).includes("/"))
        .filter(([, doc]) => !filter || doc.fields[filter.field.fieldPath]?.stringValue === filter.value.stringValue)
        .map(([name, doc]) => ({ document: { name, fields: doc.fields, updateTime: doc.updateTime } }));
      return json(200, rows.length ? rows : [{ readTime: nextTime() }]);
    }

    const name = key(url);
    const existing = documents.get(name);
    if (method === "GET") {
      if (url.searchParams.has("pageSize") || !/\/[^/]+$/.test(name) || url.pathname.endsWith("/reports")) {
        const prefix = `${name}/`;
        const docs = [...documents.entries()]
          .filter(([n]) => n.startsWith(prefix) && !n.slice(prefix.length).includes("/"))
          .map(([n, d]) => ({ name: n, fields: d.fields, updateTime: d.updateTime }));
        if (docs.length || url.pathname.endsWith("/reports")) return json(200, { documents: docs });
      }
      return existing ? json(200, { name, fields: existing.fields, updateTime: existing.updateTime }) : json(404, { error: { status: "NOT_FOUND" } });
    }

    const mustExist = url.searchParams.get("currentDocument.exists");
    const mustMatch = url.searchParams.get("currentDocument.updateTime");
    const failedPrecondition =
      options.alwaysConflict ||
      (mustExist === "false" && existing) ||
      (mustExist === "true" && !existing) ||
      (mustMatch && existing?.updateTime !== mustMatch) ||
      (mustMatch && !existing);
    if (failedPrecondition)
      return json(mustExist === "false" ? 409 : 412, { error: { status: mustExist === "false" ? "ALREADY_EXISTS" : "FAILED_PRECONDITION" } });

    if (method === "DELETE") {
      documents.delete(name);
      return json(200, {});
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init.body));
      const doc = { fields: body.fields, updateTime: nextTime() };
      documents.set(name, doc);
      return json(200, { name, fields: doc.fields, updateTime: doc.updateTime });
    }
    return json(405, {});
  };
  return { fetch: fetch as typeof globalThis.fetch, documents, put: (name: string, fields: Record<string, any>) => documents.set(name, { fields, updateTime: nextTime() }) };
}
