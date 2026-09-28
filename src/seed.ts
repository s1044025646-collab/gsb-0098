import type { Ctx } from "./domain/common.ts";

export const SEED = {
  agencies: [
    { id: "ag-edu", name: "虚构市教育局", contact: "edu@example.invalid" },
    { id: "ag-env", name: "虚构区生态环境所", contact: "env@example.invalid" },
  ],
  holidays: [
    "2026-01-01",
    "2026-10-01",
    "2026-10-02",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
  ],
  documents: [
    {
      id: "doc-budget",
      agencyId: "ag-edu",
      catalogNo: "EDU-2026-001",
      title: "2026年虚构教材采购预算表",
      segments: [
        { id: "seg-budget-1", seq: 1, content: "项目名称：虚构教材采购；预算总额：120万元。" },
        { id: "seg-budget-2", seq: 2, content: "供应商联系人：张某某，电话 13800000000。" },
        { id: "seg-budget-3", seq: 3, content: "内部评审意见：待党组会讨论，编号 INTERNAL-77。" },
      ],
    },
    {
      id: "doc-water",
      agencyId: "ag-env",
      catalogNo: "ENV-2026-014",
      title: "虚构河流水质监测月报（2026年8月）",
      segments: [
        { id: "seg-water-1", seq: 1, content: "监测断面A：pH 7.2，溶解氧 6.1mg/L，达标。" },
        { id: "seg-water-2", seq: 2, content: "监测断面B：氨氮 1.8mg/L，超标 0.3mg/L。" },
      ],
    },
    {
      id: "doc-minutes",
      agencyId: "ag-edu",
      catalogNo: "EDU-2026-009",
      title: "虚构学校布局调整论证会纪要",
      segments: [
        { id: "seg-minutes-1", seq: 1, content: "会议时间：2026-06-12；议题：三所虚构小学合并方案。" },
        { id: "seg-minutes-2", seq: 2, content: "参会人员发言要点（含个人隐私信息，略）。" },
      ],
    },
  ],
};

export function seed(ctx: Ctx): void {
  const now = ctx.clock.now().toISOString();
  const insAgency = ctx.db.prepare("INSERT OR IGNORE INTO agencies(id, name, contact) VALUES (?,?,?)");
  for (const a of SEED.agencies) insAgency.run(a.id, a.name, a.contact);
  const insHoliday = ctx.db.prepare("INSERT OR IGNORE INTO holidays(day) VALUES (?)");
  for (const h of SEED.holidays) insHoliday.run(h);
  const insDoc = ctx.db.prepare(
    "INSERT OR IGNORE INTO documents(id, agency_id, catalog_no, title) VALUES (?,?,?,?)",
  );
  const insSeg = ctx.db.prepare(
    "INSERT OR IGNORE INTO document_segments(id, document_id, seq, content) VALUES (?,?,?,?)",
  );
  for (const d of SEED.documents) {
    insDoc.run(d.id, d.agencyId, d.catalogNo, d.title);
    for (const s of d.segments) insSeg.run(s.id, d.id, s.seq, s.content);
  }
  ctx.db
    .prepare("INSERT OR IGNORE INTO applicants(id, alias, created_at) VALUES (?,?,?)")
    .run("ap-anon", "匿名申请人A", now);
}
