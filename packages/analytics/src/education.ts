/**
 * Education progress (2.8.2) — read-time derivation over two PROVEN
 * sources, nothing else:
 *
 * - `/v2/user/education` (live): `{ complete: number[], current:
 *   {id, until} | null }` — Torn publishes ONLY the completed/current
 *   state. There is NO completion history; the stored log archive carries
 *   only "Education start" rows (cost/course/duration) and no completion
 *   events, so no history is ever fabricated here.
 * - `/v2/torn/education` (public catalog): 12 categories, 143 courses with
 *   official `rewards` (working_stats + free-text effect + honor) and
 *   `prerequisites` (cost, course chain).
 *
 * Earned (completed) rewards are strictly separated from future (remaining
 * + in-progress) rewards. Free-text effects are NEVER aggregated — they are
 * official catalog strings, passed through verbatim per course.
 */

export interface EducationCatalogCourse {
  id: number;
  name: string;
  description?: string | null;
  duration?: number | null;
  rewards?: {
    working_stats?: { manual_labor?: number | null; intelligence?: number | null; endurance?: number | null } | null;
    effect?: string | null;
    honor?: string | null;
  } | null;
  prerequisites?: { cost?: number | null; courses?: number[] | null } | null;
}

export interface EducationCatalogCategory {
  id: number;
  name: string;
  courses: EducationCatalogCourse[];
}

export interface EducationRewardTotals {
  manualLabor: number;
  intelligence: number;
  endurance: number;
  effects: string[];
  honors: string[];
}

export interface EducationCourseView {
  id: number;
  name: string;
  categoryName: string;
  state: "completed" | "in_progress" | "remaining";
  durationDays: number | null;
  cost: number | null;
  reward: EducationRewardTotals;
}

export interface EducationProgress {
  currentCourse: { id: number; name: string; categoryName: string; completesAt: number; remainingSeconds: number } | null;
  completed: number;
  inProgress: number;
  remaining: number;
  total: number;
  categories: Array<{ name: string; completed: number; total: number; complete: boolean }>;
  earned: EducationRewardTotals;
  future: EducationRewardTotals;
  courses: EducationCourseView[];
  coverage: { source: "live_user_state+official_catalog"; fetchedAt: number };
}

function rewardOf(course: EducationCatalogCourse): EducationRewardTotals {
  const ws = course.rewards?.working_stats ?? null;
  return {
    manualLabor: typeof ws?.manual_labor === "number" ? ws.manual_labor : 0,
    intelligence: typeof ws?.intelligence === "number" ? ws.intelligence : 0,
    endurance: typeof ws?.endurance === "number" ? ws.endurance : 0,
    effects: course.rewards?.effect ? [course.rewards.effect] : [],
    honors: course.rewards?.honor ? [course.rewards.honor] : [],
  };
}

function addReward(into: EducationRewardTotals, from: EducationRewardTotals): void {
  into.manualLabor += from.manualLabor;
  into.intelligence += from.intelligence;
  into.endurance += from.endurance;
  into.effects.push(...from.effects);
  into.honors.push(...from.honors);
}

/** Pure derivation; null when the catalog or the user state is missing. */
export function buildEducationProgress(
  catalog: EducationCatalogCategory[] | null,
  completeIds: number[] | null,
  current: { id: number; until: number } | null,
  nowSec: number,
  fetchedAtSec: number
): EducationProgress | null {
  if (!catalog || catalog.length === 0 || completeIds === null) return null;
  const complete = new Set(completeIds);

  const earned: EducationRewardTotals = { manualLabor: 0, intelligence: 0, endurance: 0, effects: [], honors: [] };
  const future: EducationRewardTotals = { manualLabor: 0, intelligence: 0, endurance: 0, effects: [], honors: [] };
  const courses: EducationCourseView[] = [];
  const categories: EducationProgress["categories"] = [];

  for (const category of catalog) {
    let categoryCompleted = 0;
    for (const course of category.courses) {
      const state = complete.has(course.id) ? "completed" : current?.id === course.id ? "in_progress" : "remaining";
      const reward = rewardOf(course);
      if (state === "completed") {
        categoryCompleted += 1;
        addReward(earned, reward);
      } else {
        addReward(future, reward);
      }
      courses.push({
        id: course.id,
        name: course.name,
        categoryName: category.name,
        state,
        durationDays: typeof course.duration === "number" && course.duration > 0 ? Math.round(course.duration / 86_400) : null,
        cost: typeof course.prerequisites?.cost === "number" && course.prerequisites.cost > 0 ? course.prerequisites.cost : null,
        reward,
      });
    }
    categories.push({ name: category.name, completed: categoryCompleted, total: category.courses.length, complete: categoryCompleted === category.courses.length });
  }

  let currentCourse: EducationProgress["currentCourse"] = null;
  if (current && typeof current.id === "number" && Number.isFinite(current.until)) {
    const categoryOf = catalog.find((c) => c.courses.some((co) => co.id === current.id));
    const nameOf = categoryOf?.courses.find((co) => co.id === current.id)?.name ?? null;
    currentCourse = {
      id: current.id,
      name: nameOf ?? `Course #${current.id}`,
      categoryName: categoryOf?.name ?? "Unknown category",
      completesAt: current.until,
      remainingSeconds: Math.max(0, current.until - nowSec),
    };
  }

  const completed = courses.filter((c) => c.state === "completed").length;
  const inProgress = courses.filter((c) => c.state === "in_progress").length;
  return {
    currentCourse,
    completed,
    inProgress,
    remaining: courses.length - completed - inProgress,
    total: courses.length,
    categories,
    earned,
    future,
    courses: courses.sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.name.localeCompare(b.name)),
    coverage: { source: "live_user_state+official_catalog", fetchedAt: fetchedAtSec },
  };
}
