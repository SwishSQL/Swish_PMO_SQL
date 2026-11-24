import { PROJECT_PHASES } from './phases';
import type { ProjectPhase } from './phases';

// What a new project must state, stage by stage, before it can be created: the same rules for the form, the
// server and the AI assistant. Every stage also needs at least one milestone (inside the project's dates).

export type StageFieldKey =
  | 'objective'
  | 'problemStatement'
  | 'scope'
  | 'stakeholders'
  | 'businessCase'
  | 'budget'
  | 'resources'
  | 'riskPlan'
  | 'deliverables'
  | 'successMetric'
  | 'successTarget'
  | 'acceptanceCriteria';

export interface StageField {
  key: StageFieldKey;
  en: string;
  ar: string;
  hintEn: string;
  hintAr: string;
  number?: boolean;
}

export const STAGE_FIELDS: Record<ProjectPhase, StageField[]> = {
  Initiation: [
    { key: 'objective', en: 'Goal', ar: 'الهدف', hintEn: 'What the project must achieve.', hintAr: 'ما يجب أن يحققه المشروع.' },
    { key: 'problemStatement', en: 'Problem statement', ar: 'المشكلة', hintEn: 'The problem or opportunity it addresses.', hintAr: 'المشكلة أو الفرصة التي يعالجها.' },
    { key: 'scope', en: 'High-level scope', ar: 'النطاق العام', hintEn: 'What is in, and what is out.', hintAr: 'ما يشمله المشروع وما لا يشمله.' },
    { key: 'stakeholders', en: 'Key stakeholders', ar: 'أصحاب المصلحة', hintEn: 'Who is affected, who decides, who must be informed.', hintAr: 'من يتأثر، ومن يقرر، ومن يجب إبلاغه.' },
    { key: 'businessCase', en: 'Business case', ar: 'دراسة الجدوى', hintEn: 'Why it is worth doing: benefits against costs.', hintAr: 'لماذا يستحق التنفيذ: الفوائد مقابل التكلفة.' },
  ],
  Planning: [
    { key: 'budget', en: 'Budget estimate (KWD)', ar: 'الميزانية التقديرية (د.ك)', hintEn: 'The estimated cost; 0 if none.', hintAr: 'التكلفة التقديرية؛ 0 إن لم توجد.', number: true },
    { key: 'resources', en: 'Resource allocation', ar: 'توزيع الموارد', hintEn: 'People, teams, systems and suppliers needed.', hintAr: 'الأشخاص والفرق والأنظمة والموردون المطلوبون.' },
    { key: 'riskPlan', en: 'Risk management strategy', ar: 'إدارة المخاطر', hintEn: 'The main risks and how they will be handled.', hintAr: 'أهم المخاطر وطريقة التعامل معها.' },
  ],
  Execution: [
    { key: 'deliverables', en: 'Key deliverables', ar: 'المخرجات الرئيسية', hintEn: 'What will be built or delivered.', hintAr: 'ما سيتم بناؤه أو تسليمه.' },
  ],
  'Monitoring & Control': [
    { key: 'successMetric', en: 'KPIs', ar: 'مؤشرات الأداء', hintEn: 'How progress and success are measured.', hintAr: 'كيف يُقاس التقدم والنجاح.' },
    { key: 'successTarget', en: 'KPI targets', ar: 'مستهدفات المؤشرات', hintEn: 'The value each KPI must reach.', hintAr: 'القيمة المستهدفة لكل مؤشر.' },
  ],
  Closure: [
    { key: 'acceptanceCriteria', en: 'Acceptance and sign-off', ar: 'معايير القبول والاعتماد', hintEn: 'What must be true to accept the project, and who signs it off.', hintAr: 'شروط قبول المشروع، ومن يعتمده.' },
  ],
};

export const STAGE_FIELD_KEYS = Object.values(STAGE_FIELDS).flatMap((fs) => fs.map((f) => f.key));

export interface NewProjectInput {
  startDate?: unknown;
  endDate?: unknown;
  milestones?: { name?: unknown; date?: unknown; phase?: unknown }[];
  [key: string]: unknown;
}

const filled = (v: unknown, number?: boolean) =>
  number ? v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 : typeof v === 'string' && v.trim().length >= 3;

/** What is still missing, stage by stage, in the language asked for; empty when the project may be created. */
export function missingForCreation(b: NewProjectInput, lang: 'en' | 'ar' = 'en'): { phase: ProjectPhase; items: string[] }[] {
  const start = typeof b.startDate === 'string' ? b.startDate : '';
  const end = typeof b.endDate === 'string' ? b.endDate : '';
  const ms = Array.isArray(b.milestones) ? b.milestones : [];
  const out: { phase: ProjectPhase; items: string[] }[] = [];
  for (const phase of PROJECT_PHASES) {
    const items = STAGE_FIELDS[phase].filter((f) => !filled(b[f.key], f.number)).map((f) => (lang === 'ar' ? f.ar : f.en));
    const has = ms.some(
      (m) => m?.phase === phase && typeof m.name === 'string' && m.name.trim() && typeof m.date === 'string' && (!start || m.date >= start) && (!end || m.date <= end),
    );
    if (!has) items.push(lang === 'ar' ? 'مرحلة واحدة على الأقل ضمن تواريخ المشروع' : 'at least one milestone within the project dates');
    if (items.length) out.push({ phase, items });
  }
  return out;
}
