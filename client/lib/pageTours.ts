// Generated from the page-tour texts: what each step of each page tour points at. The words are in i18n
// (ptour_<page>_<key>_t / _b).

export type PageTourId = 'task' | 'mywork' | 'home' | 'project' | 'newproject' | 'milestones' | 'standup' | 'assign' | 'dashboard' | 'report' | 'people' | 'insights';

export const PAGE_STEPS: Record<PageTourId, { sel?: string; k: string }[]> = {
  task: [
    { sel: '.fact-tiles, .facts-line', k: 'facts' },
    { sel: '.update-card .form-grid > :nth-child(1)', k: 'status' },
    { sel: '.update-card .form-grid > :nth-child(2)', k: 'progress' },
    { sel: '.update-card .form-grid > :nth-child(3)', k: 'what' },
    { sel: '.update-card .form-grid > :nth-child(4)', k: 'blocker' },
    { sel: '.update-card > .btn-primary', k: 'post' },
    { sel: '.latest-update', k: 'latest' },
    { sel: '[data-tour="askmove"]', k: 'askmove' },
    { sel: '[data-tour="escalations"]', k: 'escalations' },
    { sel: '[data-tour="updatelog"]', k: 'log' },
    { sel: '[data-tour="details"]', k: 'details' },
  ],
  mywork: [
    { sel: '.ms-legend', k: 'legend' },
    { sel: '.work-group', k: 'group' },
    { sel: '.work-open', k: 'open' },
    { sel: '.work-item a.code', k: 'project' },
    { sel: '.page-head .date-range', k: 'dates' },
  ],
  home: [
    { sel: '.home-summary', k: 'summary' },
    { sel: '.hs-waiting', k: 'waiting' },
    { sel: '.hs-next-list', k: 'next' },
    { sel: '.page-head .btn-primary', k: 'new' },
    { sel: '.home-tabs', k: 'tabs' },
    { sel: '.home-tabs ~ .filters', k: 'filters' },
    { sel: '.routemap', k: 'map' },
  ],
  project: [
    { sel: '.project-head .facts', k: 'facts' },
    { sel: '.project-head .stages', k: 'stages' },
    { sel: '.ai-pm-bar', k: 'ai' },
    { sel: '.project-title-row .btn-primary', k: 'write' },
    { sel: 'nav.tabs', k: 'tabs' },
    { sel: '.gantt-toolbar', k: 'toolbar' },
    { sel: '.gantt-grid .g-row:not(.g-head):not(.is-summary)', k: 'row' },
    { sel: '.closure-bar', k: 'closure' },
  ],
  newproject: [
    { sel: '.dialog ol:has(> li.stage)', k: 'stages' },
    { sel: '.dialog-body .form-grid > :nth-child(1)', k: 'name' },
    { sel: '.dialog-body .form-grid > :nth-child(3)', k: 'dept' },
    { sel: '.dialog-body .form-grid > :nth-child(4)', k: 'owner' },
    { sel: '.dialog-body .form-grid > :nth-child(5)', k: 'sponsor' },
    { sel: '.dialog-body .form-grid > :nth-child(9)', k: 'dates' },
    { sel: '.dialog-foot', k: 'foot' },
  ],
  milestones: [
    { sel: '.page-head .segmented', k: 'scope' },
    { sel: '.ms-stats', k: 'stats' },
    { sel: '.filters', k: 'filters' },
    { sel: '.ms-table', k: 'table' },
  ],
  standup: [
    { sel: '.week-nav', k: 'week' },
    { sel: '.page-head .btn-primary', k: 'start' },
    { sel: '.table-wrap table', k: 'table' },
  ],
  assign: [
    { sel: '.page .panel', k: 'card' },
    { sel: '.page .panel select', k: 'person' },
    { sel: '.page .panel .btn-primary', k: 'buttons' },
  ],
  dashboard: [
    { sel: '.dash-tiles', k: 'tiles' },
    { sel: '.dash-grid', k: 'grid' },
    { sel: 'section.panel:has(.ms-table)', k: 'attention' },
    { sel: '.page-head .toolbar', k: 'tools' },
  ],
  report: [
    { sel: '.page-head .date-range', k: 'period' },
    { sel: '.exec-kpis', k: 'kpis' },
    { sel: '.exec-grid', k: 'grid' },
    { sel: '.page-head .btn-primary', k: 'print' },
  ],
  people: [
    { sel: 'nav.tabs', k: 'tabs' },
    { sel: '.filters .segmented', k: 'roles' },
    { sel: '.filters .search', k: 'search' },
    { sel: '.filters .btn-primary', k: 'add' },
    { sel: '.person-card .person-actions', k: 'card' },
  ],
  insights: [
    { sel: '.filters .segmented', k: 'period' },
    { sel: '.filters select', k: 'dept' },
    { sel: 'section.panel table', k: 'table' },
  ],
};
