// The phases every new project is built with, in this order. They are fixed: the person who starts a project
// ticks the ones it needs, and the others stay in the plan marked "Not required" so every project reads the
// same way.

export const PROJECT_PHASES = [
  'Definition',
  'Data Collection',
  'Analysis',
  'Design',
  'Build',
  'Validation',
  'Pilot',
  'Rollout',
  'Approval',
  'Closeout',
] as const;

export type ProjectPhase = (typeof PROJECT_PHASES)[number];
