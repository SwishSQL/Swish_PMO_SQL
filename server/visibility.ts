// Who sees what, as SQL. One place, so a project's team, its owner and its department head can never be
// counted differently in two lists.

/**
 * A project is visible to $param when it is null (sees everything), or the person owns it, is on its team,
 * or heads its department.
 */
export function projectVisibleSql(p: string, param: string): string {
  return `(${param} IS NULL OR ${p}.manager_id = ${param}
    OR EXISTS (SELECT 1 FROM project_members pm_ WHERE pm_.project_id = ${p}.id AND pm_.user_id = ${param})
    OR EXISTS (SELECT 1 FROM departments hd_ WHERE hd_.id = ${p}.department_id AND hd_.head_user_id = ${param}))`;
}

/**
 * Inside a visible project, a person sees every task when they run it (its owner, or the head of its
 * department) and otherwise only the tasks given to them, as owner or co-owner.
 */
export function taskVisibleSql(t: string, p: string, param: string): string {
  return `(${param} IS NULL OR ${p}.manager_id = ${param}
    OR EXISTS (SELECT 1 FROM departments hd2_ WHERE hd2_.id = ${p}.department_id AND hd2_.head_user_id = ${param})
    OR ${t}.assignee_id = ${param}
    OR EXISTS (SELECT 1 FROM task_coowners tc_ WHERE tc_.task_id = ${t}.id AND tc_.user_id = ${param}))`;
}
