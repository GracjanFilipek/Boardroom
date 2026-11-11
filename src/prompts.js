const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}\n[cut]` : s || '');

function context(project, handovers) {
  const parts = [`# Project: ${project.name}`, '', '## Brief from the CEO', project.brief || '(no brief yet)'];
  if (project.memo) parts.push('', '## Standing guidance from the CEO, kept by the project manager', project.memo);
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
          needs_design: { type: 'boolean', description: 'True when the task changes what a person sees or does' },
        },
        required: ['title', 'pitch', 'plan', 'effort', 'needs_design'],
      },
    },
  },
  required: ['ideas'],
});

export const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'What you say back to the CEO. Plain and short.' },
    memo: { type: 'string', description: 'The full standing guidance for the team after this conversation. Include it only when the guidance changes, and then write the whole memo, old points included.' },
    tasks: {
      type: 'array',
      maxItems: 4,
      description: 'Work the CEO asked for that should start now. Leave empty when the CEO only shared a view.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          plan: { type: 'string', description: 'Work order for the developer' },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
          needs_design: { type: 'boolean' },
        },
        required: ['title', 'plan', 'effort', 'needs_design'],
      },
    },
    withdraw_proposals: { type: 'boolean', description: 'True when your pending proposals no longer fit what the CEO said and you will draft a new round.' },
  },
  required: ['reply'],
};

export function chatPrompt({ project, handovers, conversation, pending, open, done }) {
  const list = (rows, fmt) => (rows.length ? rows.map(fmt).join('\n') : '(none)');
  return `${context(project, handovers)}

## Your role
You are the project manager and the CEO is talking to you. Read the repository when the answer depends on the code.

## State of the project
Proposals waiting for the CEO:
${list(pending, (i) => `- ${i.title}`)}
Tasks in work:
${list(open, (t) => `- ${t.title} (${t.status})`)}
Shipped recently:
${list(done, (t) => `- ${t.title}`)}

## Conversation so far, oldest first
${conversation.map((m) => `${m.role === 'ceo' ? 'CEO' : 'You'}: ${m.text}`).join('\n\n')}

## Task
Answer the CEO's latest messages, then act on them:
- If the CEO set a direction, a preference or a rule the team must follow from now on, rewrite the standing guidance in \`memo\`. Developers and the designer read that memo before each run, so write it for them: short imperative points. Keep earlier points that still hold. Keep it under 250 words.
- If the CEO asked for specific work, put it in \`tasks\` with a full work order. These start without further approval, because the CEO asked.
- If what the CEO said makes your pending proposals wrong, set \`withdraw_proposals\` and you will draft a new round with this in mind.
- If the CEO is wrong about the code or the idea has a cost they may not see, say so in one or two sentences and give your recommendation. Then do what they decided.
Say in your reply what you did and what the team will do next. Reply in the CEO's language.`;
}

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'revise'] },
    notes: { type: 'string', description: 'For approve: one line on what shipped. For revise: the exact changes the developer must make.' },
  },
  required: ['verdict', 'notes'],
};

export function ideatePrompt({ project, handovers, count, done, open, rejected, conversation = [] }) {
  const list = (rows, fmt) => (rows.length ? rows.map(fmt).join('\n') : '(none)');
  return `${context(project, handovers)}

## Your role
You are the project manager. You own this project's roadmap, and the ideas are your job. The brief may be one rough sentence: work out what the product needs to become, what is missing, and the best order to build it in. Propose things the CEO did not ask for when they serve the goal. The CEO reads your proposals and approves or rejects each one. Developers then build the approved ones without asking questions, so each plan must stand on its own.

Read the repository in the working directory before you propose anything.

## Already shipped
${list(done, (t) => `- ${t.title}`)}

## In the pipeline, do not duplicate
${list(open, (t) => `- ${t.title}`)}

## Your recent conversation with the CEO
${conversation.length ? conversation.map((m) => `${m.role === 'ceo' ? 'CEO' : 'You'}: ${m.text}`).join('\n\n') : '(none)'}

## Rejected by the CEO, do not propose again
${list(rejected, (i) => `- ${i.title}${i.reason ? ` (reason: ${i.reason})` : ''}`)}

## Task
Propose up to ${count} ideas, the most valuable first. Each idea must fit in one developer session. Prefer work that moves the product forward over cleanup. Build on what already shipped, and take the reasons behind past rejections as direction. If the repository is empty, start with the smallest version that runs.
Write in the language of the brief.`;
}

export function designPrompt({ project, handovers, idea }) {
  return `${context(project, handovers)}

## Your role
You are the designer. The project manager drafted the proposal below and asked you for the design before it goes to the CEO. Read the repository first: find the design system and the screens closest to this work.

## Proposal: ${idea.title}
${idea.pitch}

### Work order from the project manager
${idea.plan}

## Task
Write the design spec a developer will build from. Reply with the spec only, in the language of the brief.`;
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
