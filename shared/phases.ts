// The phases every new project is built with, in this order. They are fixed: the person who starts a project
// ticks the ones it needs, and the others stay in the plan marked "Not required" so every project reads the
// same way.

// They follow the project lifecycle, the same five as the project's stages. Projects made before keep the
// phases they were built with.
export const PROJECT_PHASES = ['Initiation', 'Planning', 'Execution', 'Monitoring & Control', 'Closure'] as const;

export type ProjectPhase = (typeof PROJECT_PHASES)[number];
