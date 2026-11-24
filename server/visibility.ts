// Who sees what, as SQL. One place, so a project's team, its owner and its department head can never be
// counted differently in two lists.

/**
 * A project is visible to $param when it is null (sees everything), or the person owns it, heads its department,
 * has a task or milestone in it (owner or co-owner), or is on its team in a named role (team lead, expert,
 * reviewer, PMO coordinator). A plain "Member" with nothing given to them does not see it yet: no confusion.
 */
export function projectVisibleSql(p: string, param: string): string {
  return `(${param} IS NULL OR ${p}.manager_id = ${param}
    OR EXISTS (SELECT 1 FROM project_members pm_ WHERE pm_.project_id = ${p}.id AND pm_.user_id = ${param} AND pm_.role <> 'Member')
    OR EXISTS (SELECT 1 FROM tasks tv_ WHERE tv_.project_id = ${p}.id AND tv_.status <> 'cancelled'
                 AND (tv_.assignee_id = ${param} OR EXISTS (SELECT 1 FROM task_coowners tc2_ WHERE tc2_.task_id = tv_.id AND tc2_.user_id = ${param})))
    OR EXISTS (SELECT 1 FROM departments hd_ WHERE hd_.id = ${p}.department_id AND hd_.head_user_id = ${param})
    OR ${managesSql(p, param)})`;
}

/** The project sits in a program or a portfolio this person manages (they watch it). */
export function managesSql(p: string, param: string): string {
  return `EXISTS (SELECT 1 FROM initiatives mi_ JOIN dimensions md_ ON md_.id = mi_.dimension_id JOIN capabilities mc_ ON mc_.id = md_.capability_id
                 WHERE mi_.id = ${p}.initiative_id AND (md_.manager_user_id = ${param} OR mc_.manager_user_id = ${param}))`;
}

/**
 * Inside a visible project, a person sees every task when they run it (its owner, or the head of its
 * department) and otherwise only the tasks given to them, as owner or co-owner.
 */
export function taskVisibleSql(t: string, p: string, param: string): string {
  return `(${param} IS NULL OR ${p}.manager_id = ${param}
    OR EXISTS (SELECT 1 FROM departments hd2_ WHERE hd2_.id = ${p}.department_id AND hd2_.head_user_id = ${param})
    OR ${managesSql(p, param)}
    OR ${t}.assignee_id = ${param}
    OR EXISTS (SELECT 1 FROM task_coowners tc_ WHERE tc_.task_id = ${t}.id AND tc_.user_id = ${param}))`;
}
