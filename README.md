# household-sim

Test an MCP server the way a household uses it.

A voice add-on is not used by one person typing. Several people talk to it, each with
their own account. A model picks its tools from their descriptions. Devices in the house
change the record between one conversation and the next, and every reply is read aloud.
Unit tests do not cover any of that, and trying it by hand on a speaker is slow and hard
to repeat.

household-sim plays that household against your server and checks what happens:

```
nobody has the fuel  examples/house-rota/scenarios/nobody-has-the-fuel.yaml
✓  1  fuel gauge → POST /hooks/fuel
✓  2  Grandma: "Is anything waiting on someone this morning?"
       [list_chores] Yes, the generator fuel has been waiting for someone since this morning at 7:10 AM, and the water tank also needs someone to take it.
✓  3  Ada: "I'll get the diesel on my way back."
       [take_chore] Got it, Ada. You have the generator fuel now.
✓  4  time moves +3h → Wednesday, October 14, 2026 at 10:10 AM
✓  5  Tunde: "I'll sort out the fuel for the generator."
       [take_chore!] Ada already has the generator fuel. Do you want to take it over from Ada?
✓  6  Tunde: "No, leave it with Ada."
       [no tools] Okay, I'll leave the generator fuel with Ada.
✓  7  Ada: "Done, the generator is full."
       [mark_done] Great! I've marked the generator fuel as done.
✓  8  Grandma reads rota://week
PASS nobody has the fuel: 8/8 steps · replay of bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0 · 0.7s
```

Each person connects with their own credential, as a real MCP client over Streamable
HTTP. A model plays the assistant, using only what your server tells it. Devices send
signed webhooks. A story clock moves time forward without waiting. Every step is checked,
and a model's choices can be recorded once and replayed in CI for free.

## Try it

You need Node 22 or newer. To check your own server, nothing to clone:

```sh
npx household-sim check https://your-server.example/mcp --token <a user's token>
```

To see it play whole scenarios against a sample add-on:

```sh
git clone https://github.com/Osiyomeoh/household-sim
cd household-sim
npm ci
npm run examples        # three scenarios, replayed: no model, no account, no cost
npm test
```

`examples/house-rota` is a small MCP add-on to test against: three people (Ada, Tunde,
Grandma), three chores, and a fuel gauge that reports by webhook. Run it yourself and
look at it:

```sh
npm run rota                                                    # http://localhost:8790/mcp
npx tsx src/cli.ts check http://localhost:8790/mcp --token local-ada
```

## Two commands

### `check`: will a host and its model be able to use this server?

```sh
household-sim check https://your-server.example/mcp --token env:MY_TOKEN
```

No model and no scenario are needed. It connects and reports:

- whether the server answers, which protocol version it settles on, and whether it is
  stateless or hands out sessions;
- on a 401, whether it says how to sign in (`WWW-Authenticate`, OAuth protected-resource
  metadata);
- for each tool: missing or thin descriptions, arguments with no description, names that
  MCP allows but some model APIs refuse, schemas that are not objects, `required` fields
  that do not exist, duplicate names, and missing `readOnlyHint`/`destructiveHint`;
- how big the tool list is, since every turn sends it;
- slow handshakes.

It exits 1 when it finds an error, so it can guard a deploy.

### `run`: play scenarios

```sh
household-sim run scenarios/*.yaml                # live, with the default model
household-sim run scenarios/*.yaml --record       # live, and save the model's choices
household-sim run scenarios/*.yaml --replay       # replay them: no model calls
household-sim run scenarios/*.yaml --replay --junit junit.xml
```

| Option              | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `--model <spec>`    | which model plays the assistant (see [Models](#models))               |
| `--record`          | save each model choice to `cassettes/<scenario>.json` beside the file |
| `--replay`          | play the saved choices back instead of calling a model                |
| `--cassettes <dir>` | keep recordings somewhere else                                        |
| `--url <url>`       | test a server that is already running; skip the scenario's `start`    |
| `--bail`            | stop a scenario at its first failed step                              |
| `--junit <file>`    | write JUnit XML for CI                                                |
| `--json <file>`     | write every step, reply and tool call as JSON                         |

Exit status: 0 when everything passed, 1 when something failed, 2 when the command or a
scenario file is wrong. Scenario files are checked completely before anything runs, so a
misspelt name fails in a second, not after five model calls.

## Writing a scenario

A scenario is one household and what happens to it, in order.

```yaml
name: nobody has the fuel

server:
  url: http://localhost:8790/mcp
  start: npx tsx ../server.ts # optional: the runner starts it and stops it after
  ready: http://localhost:8790/health # optional: polled until it answers
  env: { PORT: '8790', ROTA_HOOK_SECRET: example-secret }

members: # id: token, or id: { name, token }
  ada: local-ada
  tunde: env:TUNDE_TOKEN # env:NAME reads the environment
  grandma: { name: Grandma, token: local-grandma }

host:
  timezone: Africa/Lagos # the assistant's "today" and "tonight"
  prompt: Prefer short answers. # added to the assistant's instructions
  maxSteps: 6 # tool rounds per turn before it counts as stuck

clock:
  start: 2026-10-14T06:10:00Z # story time starts here and only moves when told
  header: X-Story-Time # optional: sent on every request

always: # checked on every spoken reply
  speakable: true
  maxWords: 60

steps:
  - device: fuel gauge
    webhook:
      url: /hooks/fuel # relative to the server
      body: { level: 18, at: '{{now}}' }
      sign: { secret: example-secret } # HMAC-SHA256 of the body, hex, in X-Signature

  - say: Is anything waiting on someone this morning?
    as: grandma
    expect:
      called: [list_chores]
      notCalled: [take_chore]
      says: ['/fuel|diesel|generator/i']

  - clock: +3h # also starts a new conversation for everyone

  - call: take_chore # a direct call, as a button on a screen would
    as: tunde
    args: { chore: fuel }
    expect: { error: true, result: 'Ada already has' }

  - read: rota://week
    as: grandma
    expect: { matches: ['done by Ada'] }
```

### Steps

| Step     | What happens                                                          | Needs a model |
| -------- | --------------------------------------------------------------------- | ------------- |
| `say`    | a member speaks; the model picks tools and replies                    | yes           |
| `call`   | a member's client calls one tool directly                             | no            |
| `read`   | a member reads a resource                                             | no            |
| `device` | a webhook is sent, optionally signed (`header`, `encoding`, `prefix`) | no            |
| `clock`  | story time moves: `+2h`, `+90m`, `+1d`, `+1h30m`, or an ISO time      | no            |

A scenario with no `say` steps never calls a model, so it runs anywhere and always gives
the same answer.

### Checks

Text is matched case-insensitively as a substring. Write `/pattern/flags` for a regular
expression.

| Check       | Steps             | Passes when                                                               |
| ----------- | ----------------- | ------------------------------------------------------------------------- |
| `called`    | say               | each tool was called (`inOrder: true` for this order)                     |
| `notCalled` | say, always       | none of these tools was called                                            |
| `says`      | say               | the reply matches every one                                               |
| `neverSays` | say, always       | the reply matches none                                                    |
| `result`    | say, call         | some tool result matches each one                                         |
| `error`     | say, call         | `true`: a call failed. `false`: none did. Direct calls default to `false` |
| `speakable` | say, always       | no markdown, links or emoji in the reply                                  |
| `maxWords`  | say, always       | the reply is at most this long                                            |
| `maxMs`     | say, call, always | the step finished in time                                                 |
| `matches`   | read              | the resource text matches every one                                       |
| `status`    | device            | the webhook got one of these statuses (default: any 2xx)                  |

Every `say` step also fails if the reply is empty or the model is still calling tools after
`maxSteps` rounds.

### Tokens from a setup command

If your server makes its members at start-up, give a command that prints their tokens as
JSON on its last line. It runs after the server is ready:

```yaml
setup: node scripts/seed-test-household.js # prints {"ada": "...", "tunde": "..."}
```

## Models

| Spec                 | Where it runs                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bedrock:<model id>` | Amazon Bedrock, with the usual AWS credentials (`AWS_PROFILE`, `AWS_REGION`). The default is `bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `openai:<model>`     | OpenAI, or any compatible server with `OPENAI_BASE_URL`; key in `OPENAI_API_KEY`                                                                    |
| `ollama:<model>`     | a local Ollama (`OLLAMA_HOST`, default `http://localhost:11434`): no account, no cost                                                               |

Every model runs at temperature 0. Trying more than one model is worth doing: tools that
only work with one model's habits will break with the next host's planner.

### Record and replay

`--record` saves every model turn, and which step and member it belonged to, to
`cassettes/<scenario>.json`. `--replay` plays those turns back, while the tool calls still
go to your real server. So the server is fully tested on every replay; only the model's
side is fixed. That is what makes it cheap enough for CI.

A replay will not pretend. It fails, and asks you to record again, when the scenario has
changed under it or a recorded call names a tool that no longer exists. When a tool's
description or schema has changed since the recording, the replay still runs, but it says
so: the saved choices were made against the old descriptions.

A run that breaks part-way (a refused model call, a server that went away) is not saved.
A run whose checks fail is saved, because it is a true record of what the model did.

## In CI

```yaml
- run: npm ci
- run: npx household-sim run scenarios/*.yaml --replay --junit junit.xml
```

Add it to your project with `npm install --save-dev household-sim`.
This repository's own workflow, [`.github/workflows/ci.yml`](.github/workflows/ci.yml), does
the same for the examples.

Or use it as a GitHub Action. Each finding or failed step becomes an annotation on the
run, and the job summary gets a table:

```yaml
- uses: Osiyomeoh/household-sim@main
  with:
    url: https://your-server.example/mcp
    token: ${{ secrets.MCP_TEST_TOKEN }} # masked, and never on the command line

- uses: Osiyomeoh/household-sim@main
  with:
    command: run
    scenarios: scenarios/*.yaml # replayed: no model, no credentials
    junit: junit.xml
```

`check` is the default command. `run` takes `mode` (`replay`, `record` or `live`), `model`,
`cassettes` and `url`, as the CLI does. The `ok` output is `true` when everything passed,
and `report` is the path of the full results as JSON.
[`.github/workflows/action.yml`](.github/workflows/action.yml) runs the action on the
examples, and checks the official MCP reference server,
[`@modelcontextprotocol/server-everything`](https://www.npmjs.com/package/@modelcontextprotocol/server-everything),
with it.

## Using it from code

```ts
import { loadScenario, runScenario, checkServer } from 'household-sim';

const report = await runScenario(loadScenario('scenarios/fuel.yaml'), { mode: 'replay' });
if (!report.ok) process.exit(1);
```

`runScenario` also takes `provider`, for any model with a `start(system, tools)` method.
The tests use a scripted one.

## What it is not

- **It is not Alexa+, or any real voice host.** It stands in for one. The assistant here is
  a generic model with a short prompt (see `BASE_RULES` in `src/assistant.ts`). A real host
  has its own planner, prompt and rules, and will not choose exactly the same. What carries
  over is whether your tools, descriptions, errors and replies hold up when a model has
  only them to go on.
- **It does not hear or speak.** Utterances go in as text and replies come out as text.
  "Speakable" is a check on the text, not on audio.
- **Story time is for test copies only.** A server that reads the clock header should
  believe it only in a test build. A real household's server must use the real time.

## Where it came from

It began as the simulator for We've Got This, an Alexa+ add-on that keeps track of who is
looking after what for a family member who needs care. Testing it meant several
family members on their own accounts, a model choosing the tools, a doorbell and a phone
sending events, and days passing, all in one story. The bugs that hurt most needed all of
that at once. The worst put an appointment on the family's board dated 19 December 2024,
because the model had never been told today's date. household-sim is the part of that
simulator that works for any MCP server.

## License

MIT
