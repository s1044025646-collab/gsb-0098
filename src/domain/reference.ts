import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { toIso, type Clock } from "./clock.ts";
import { withTransaction } from "../db.ts";

export interface CatalogSeed {
  agency: { id: string; name: string; code: string };
  channels: { id: string; name: string }[];
  applicants: { id: string; pseudonym: string; contact: string }[];
  items: {
    id: string;
    title: string;
    description: string;
    sensitivity: "normal" | "partial" | "secret";
    segments: { label: string; text: string }[];
  }[];
}

/** 全部为虚构资料。 */
export const FICTIONAL_SEED: CatalogSeed = {
  agency: { id: "agy_demo", name: "虚构市示例行政机关", code: "XN-001" },
  channels: [
    { id: "ch_online", name: "线上窗口（虚构）" },
    { id: "ch_post", name: "邮政信函（虚构）" },
    { id: "ch_counter", name: "现场窗口（虚构）" },
  ],
  applicants: [
    { id: "app_a", pseudonym: "匿名申请人A", contact: "a@example.invalid" },
    { id: "app_b", pseudonym: "匿名申请人B", contact: "b@example.invalid" },
  ],
  items: [
    {
      id: "doc_plan",
      title: "虚构河滨步道改造方案（节选）",
      description: "含可公开规划段落与内部审批意见",
      sensitivity: "partial",
      segments: [
        {
          label: "规划摘要",
          text: "本项目拟对河滨步道进行无障碍改造，全长1.2公里，含透水铺装与照明提升。",
        },
        {
          label: "预算明细",
          text: "项目概算总投资380万元，其中铺装210万元、照明90万元、绿化80万元。",
        },
        {
          label: "内部审批意见",
          text: "审批意见：该地块涉及未公开谈判底价，建议在签约前保密，底价不得对外提供。",
        },
      ],
    },
    {
      id: "doc_minutes",
      title: "虚构联席会议纪要（节选）",
      description: "部分内容涉及第三方商业秘密",
      sensitivity: "partial",
      segments: [
        {
          label: "会议时间与议题",
          text: "2026年3月5日召开联席会议，议题为步道改造排期与交通疏导。",
        },
        {
          label: "第三方报价",
          text: "丙公司报价及成本构成属于其商业秘密，不予公开，相关段落需删隐。",
        },
      ],
    },
    {
      id: "doc_public_notice",
      title: "虚构施工公告",
      description: "完全公开",
      sensitivity: "normal",
      segments: [
        { label: "公告正文", text: "2026年4月1日至4月20日河滨路分段施工，请过往车辆按指示绕行。" },
      ],
    },
  ],
};

/** 幂等写入虚构基础资料（按固定 ID 去重），迁移后可重复执行。 */
export function seedReferenceData(db: DatabaseSync, clock: Clock, seed: CatalogSeed = FICTIONAL_SEED): void {
  withTransaction(db, () => {
    const now = toIso(clock.now());
    db.prepare("INSERT INTO agency(id,name,code,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING").run(
      seed.agency.id,
      seed.agency.name,
      seed.agency.code,
      now
    );
    for (const c of seed.channels) {
      db.prepare("INSERT INTO channel(id,name,active) VALUES(?,?,1) ON CONFLICT(id) DO NOTHING").run(c.id, c.name);
    }
    for (const a of seed.applicants) {
      db.prepare(
        "INSERT INTO applicant(id,pseudonym,contact,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING"
      ).run(a.id, a.pseudonym, a.contact, now);
    }
    for (const item of seed.items) {
      db.prepare(
        `INSERT INTO catalog_item(id,agency_id,title,description,default_sensitivity,created_at)
         VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
      ).run(item.id, seed.agency.id, item.title, item.description, item.sensitivity, now);
      let offset = 0;
      for (const seg of item.segments) {
        const start = offset;
        const end = offset + seg.text.length;
        offset = end;
        db.prepare(
          `INSERT INTO item_segment(id,catalog_item_id,label,start_offset,end_offset,full_text,created_at)
           SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM item_segment WHERE catalog_item_id = ? AND label = ?)`
        ).run(newId("seg"), item.id, seg.label, start, end, seg.text, now, item.id, seg.label);
      }
    }
  });
}
