const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}\n[cut]` : s || '');

function context(project, handovers) {
  const parts = [`# Project: ${project.name}`, '', '## Brief from the CEO', project.brief || '(no brief yet)'];
  if (handovers.length) {
    parts.push('', '## Handover notes from earlier conversations');
    let room = 24000;
    for (const h of handovers) {
      const body = clip(h.body, Math.min(room, 8000));
      room -= body.length;
      parts.push(`### ${h.title}`, body);
      if (room <= 0) break;
    }
  }
  return parts.join('\n');
}

export const IDEAS_SCHEMA = (count) => ({
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      minItems: 1,
      maxItems: count,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative title, under 70 characters' },
          pitch: { type: 'string', description: 'Two sentences for the CEO: what changes and who benefits' },
          plan: { type: 'string', description: 'Work order for the developer: concrete steps, files to touch, how to verify' },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
        },
        required: ['title', 'pitch', 'plan', 'effort'],
      },
    },
  },
  required: ['ideas'],
});

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'revise'] },
    notes: { type: 'string', description: 'For approve: one line on what shipped. For revise: the exact changes the developer must make.' },
  },
  required: ['verdict', 'notes'],
};

export function ideatePrompt({ project, handovers, count, done, open, rejected }) {
  const list = (rows, fmt) => (rows.length ? rows.map(fmt).join('\n') : '(none)');
  return `${context(project, handovers)}

## Your role
You are the project manager. You own this project's roadmap, and the ideas are your job. The brief may be one rough sentence: work out what the product needs to become, what is missing, and the best order to build it in. Propose things the CEO did not ask for when they serve the goal. The CEO reads your proposals and approves or rejects each one. Developers then build the approved ones without asking questions, so each plan must stand on its own.

Read the repository in the working directory before you propose anything.

## Already shipped
${list(done, (t) => `- ${t.title}`)}

## In the pipeline, do not duplicate
${list(open, (t) => `- ${t.title}`)}

## Rejected by the CEO, do not propose again
${list(rejected, (i) => `- ${i.title}${i.reason ? ` (reason: ${i.reason})` : ''}`)}

## Task
Propose up to ${count} ideas, the most valuable first. Each idea must fit in one developer session. Prefer work that moves the product forward over cleanup. Build on what already shipped, and take the reasons behind past rejections as direction. If the repository is empty, start with the smallest version that runs.
Write in the language of the brief.`;
}

export function buildPrompt({ project, handovers, task, peers }) {
  return `${context(project, handovers)}

## Your role
You are a developer on this project. Your project manager assigned you the task below. Nobody answers questions during the run, so make reasonable decisions and note them in your report.

## Task: ${task.title}
${task.spec}

## Rules
- Work only inside the current directory.
- Keep the change scoped to this task.${peers ? '\n- Other developers edit this tree at the same time. Touch only the files your task needs and stage only your own files.' : ''}
- Run the tests or the app to check your work when the project has a way to do it.
- If the directory is a git repository, commit your work with a clear message. Do not push.

## Report
End with a short report for the project manager: what you changed, how you verified it, and anything left open.`;
}

export function revisePrompt({ task }) {
  return `Your project manager reviewed the task "${task.title}" and sent it back.

## Review notes
${task.review_notes}

Make these changes, verify them, commit, and end with an updated report.`;
}

export function reviewPrompt({ project, handovers, task }) {
  return `${context(project, handovers)}

## Your role
You are the project manager. A developer finished a task. Check the work against the spec. You can read files and run git status, git diff, git log and git show.

## Task: ${task.title}
${task.spec}

## Developer report (round ${task.iteration + 1})
${clip(task.report, 6000) || '(empty report)'}

## Decision
Approve when the work meets the spec. Send it back only for defects that matter: missing requirements, broken behaviour, no verification. Give exact instructions when you send it back.`;
}

export function summarizePrompt({ title, transcript }) {
  return `Below is a transcript of an earlier conversation titled "${title}". Write a handover brief for a team that continues this work without access to the transcript.

Cover, in this order: the goal, decisions already made and why, the current state, open questions, and the next steps. Use plain bullet points. Keep it under 500 words. Write in the language of the transcript.

<transcript>
${clip(transcript, 120000)}
</transcript>`;
}
