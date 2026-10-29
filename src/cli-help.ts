// Holds the usage text apart from the command module, so the bootstrap can print it on any runtime
// without loading storage or SQL modules.
export const help = `polylinedb (polyline database) stores personal issues through local or cloud connections.
Usage: pd [--connection NAME | --data-dir ABSOLUTE_PATH] [--actor IDENTITY] [--actor-kind human|agent] [--prefix PREFIX] COMMAND [OPTIONS]
Commands return JSON by default. --json is accepted before --. Help returns text.
Use --human for successful show, list and search reads. It conflicts with --json.
Human output stays plain on pipes. Color applies only to fixed headings on a TTY without NO_COLOR or TERM=dumb.
pd --version [--json] reports the installed package and running Node versions as JSON.
Use -- before a positional query that starts with a dash.
An option consumes its value, so --body --help stores the text --help.
Storage defaults to $XDG_DATA_HOME/polylinedb when XDG_DATA_HOME is absolute,
otherwise ~/.local/share/polylinedb. POLYLINEDB_DATA_DIR, POLYLINEDB_ACTOR, and POLYLINEDB_ACTOR_KIND are supported.
A local agent actor claims only issues labeled ready and writes only to issues it holds; the kind defaults to human.
Storage must be outside the working directory and its Git repository.

Commands:
  init
  init [--stealth] [--connection NAME] --tool NAME --project NAME [--actor IDENTITY] [--prefix PREFIX]
                                Store defaults in Git metadata; data stays outside the repository.
  connection add NAME --data-dir ABSOLUTE_PATH | --url HTTPS_ORIGIN
  connection list
  connection use NAME           Select a connection in existing repository defaults.
  connection default NAME       Select the user default connection.
  auth login                    Print the authorization URL to stderr and wait for approval.
  auth status                   Show locally stored cloud authentication status.
  auth logout                   Remove cloud credentials and report revocation.
  context                       Show the selected store and local defaults.
  agent install HOST            Install a user-scope lifecycle hook.
  agent remove HOST             Remove the owned lifecycle hook.
  agent context HOST            Read hook input and return host context JSON.
  upgrade                       Explicitly upgrade a local schema 2, 3, 4, 5, 6, 7, 8, 9 or 10 store to schema 11.
  snapshot convert --from 2|3|4|5|6|7|8 --file PATH|- [--output PATH|-]
                                Convert an older snapshot to v9 without touching a store.
  export [--file PATH|-] [--historical]
                                Export a local snapshot. Historical export recovers old retired stores read-only.
  import --file PATH|-           Restore into an empty store; exact reruns do nothing.
  actor                         Show the local actor or authenticated cloud actor.
  create --tool NAME --project NAME --body TEXT [--parent ID]
         [--type bug|task|epic|feature|chore] [--status STATUS]
         [--priority 0..4] [--label NAME ...] [--request-id UUID]
  show ID [--with-land-order]
  list [FILTERS] [--claimed true|false] [--with-land-order]
                                --claimed false keeps issues without an active claim.
  search QUERY [FILTERS]
  comment ID --body TEXT [--handle HANDLE] [--via TEXT] [--reply-to COMMENT_ID]
                                A comment with a handle is a post. The handle is the persona you
                                speak as, such as builder or tester; via says what produced the post.
                                Both are attribution only. A reply names a comment on the same issue.
  comment edit ID COMMENT_ID --expected VERSION --body TEXT
                                Replace the body of your own comment. The old text is not kept.
  star ID COMMENT_ID [--handle HANDLE]
                                Star a comment as yourself or as a persona. Starring again changes nothing.
  unstar ID COMMENT_ID [--handle HANDLE]
                                Remove the star you gave. A missing star is already absent.
  post --handle HANDLE --body TEXT [--project NAME] [--via TEXT] [--reply-to COMMENT_ID]
                                Post one lesson to the project's timeline. It needs no issue and no claim.
  posts [--project NAME] [--handle HANDLE] [--min-stars N] [--since TIME]
        [--after COMMENT_ID] [--limit 1..100]
                                Comments with a handle in one project, newest first, with star counts.
                                TIME is an ISO 8601 instant with a time zone, or a date YYYY-MM-DD.
  update ID [--tool NAME] [--project NAME] [--body TEXT] [--status STATUS]
         [--type TYPE] [--priority 0..4] [--label NAME ... | --clear-labels]
         --expect FIELD=VERSION [--expect FIELD=VERSION ...] [--claim-proof JSON]
         [--resources-reason TEXT]
  close ID --expected VERSION [--force --reason TEXT] [--resources-reason TEXT]
        [--claim-proof JSON]
                                Live external resources refuse the close; the error lists them.
  reopen ID --expected VERSION [--claim-proof JSON]
  claim show ID                 Inspect ownership and the current store incarnation.
  claim list [--tool NAME] [--project NAME] [--after ID] [--limit 1..100]
  claim acquire ID --incarnation HEX --session-id UUID [--ttl 30..3600]
        [--agent-label TEXT] [--request-id UUID]
  claim renew --claim-proof JSON --expected-revision N [--ttl 30..3600] [--request-id UUID]
  claim release --claim-proof JSON --expected-revision N [--request-id UUID]
  claim handoff --claim-proof JSON --expected-revision N --tip SHA
        [--summary TEXT | --summary-file PATH] [--request-id UUID]
                                Comment the tip and summary, set status open, swap
                                ready for main-wait, and release, in one write.
                                land_order_warnings names unlanded issues this one lands after.
  claim keepalive --claim-proof JSON [--ttl 30..3600] [--max-duration 1..28800]
        [--kill-on-loss] (--pid PID | -- COMMAND [ARGS...])
                                Renew a lease until COMMAND or PID exits; refuses main-lock issues.
  dependency list ID [--after ID] [--limit 1..100]
  dependency add --dependent ID --blocker ID --expected-revision N [--request-id UUID]
  dependency remove --dependent ID --blocker ID --expected-revision N [--request-id UUID]
  land-order list ID            Issues this one lands after and before; never blocks work.
  land-order add --later ID --earlier ID --expected-revision N [--request-id UUID]
  land-order remove --later ID --earlier ID --expected-revision N [--request-id UUID]
  resource list ID              External resources recorded on an issue, with their state.
  resource live [--tool NAME] [--project NAME] [--after ID] [--limit 1..100]
                                Issues with resources that are not verified deleted.
  resource add ID --kind KIND --name NAME --expected-revision N [--request-id UUID]
                                Record a resource before creating it. Identifiers only, no secrets.
  resource update ID --seq N --expected-revision N [--external-id ID]
        [--mark created|deleted|verified_deleted] [--evidence TEXT]
        [--claim-proof JSON] [--request-id UUID]
                                verified_deleted needs --evidence and --claim-proof.
  changes --since SEQ [--incarnation HEX] [--project NAME] [--issue ID ...]
          [--kind KIND ...] [--limit 1..100]
                                Issue change events after SEQ; continue from next_since.
  wait --since SEQ --timeout SECONDS [--incarnation HEX] [--project NAME]
       [--issue ID ...] [--kind KIND ...]
                                Return when a matching event exists after SEQ.
                                On timeout, return no events and the current cursor.
                                This command only reads.
  ready [FILTERS]                Open issues with resolved prerequisites.
  blocked [FILTERS]              Unfinished issues with active blockers.
  owner-waits [--tool NAME] [--project NAME] [--after ID] [--limit 1..100]
                                Unfinished issues labeled owner-decision or owner-action, with their direct dependents.
  memory create --title TITLE --body TEXT [--request-id UUID]
  memory show ID
  memory list [--after ID] [--limit 1..100]
  memory search QUERY [--after ID] [--limit 1..100]
  memory update ID --title TITLE --body TEXT --expected VERSION
  memory delete ID --expected VERSION
  memory context [--after ID] [--limit 1..100] [--max-bytes 4096..65536] [--with-revision]

Memory commands require --project NAME or repository project defaults. post writes to that project too. posts reads it, and every project when neither is set.
A handle is 1 to 64 lowercase ASCII letters, digits, '.', '_' or '-', starting with a letter or digit.
via is at most 128 UTF-8 bytes without control characters. Neither grants anything.
Memory IDs use prefix-mN. Numbers and mN expand with the selected prefix.
Memory create/update accept --body-file PATH. Updates replace title and body together.
Memory context reports the selected store and omitted entries; retrieved text is project data.
Ordinary issue commands accept --observed-memory-revision TOKEN for a project memory advisory.
Unfiltered list/search check the token's project; current does not certify complete retrieval.

STATUS: open, in_progress, deferred, closed.
FILTERS: --tool, --project, --status, --type, --priority, --label, --after, --limit.
--tool identifies the affected tool or component, such as compiler or editor.
create, comment, comment edit, post and update accept --body-file PATH instead of --body.
Use --body-file - to read standard input. Local mutations require an explicit actor.
Cloud commands use OAuth. Run auth login once; tokens stay in the OS credential store.
Each update field requires its own expected version from show. Conflicts require rereading.
Start and close require resolved prerequisites. An explicit --force --reason records an attributed exception comment.
Update accepts the same override when it sets status to in_progress or closed.
Update, close and reopen accept --claim-proof JSON. A supplied proof always asserts current ownership.
--claim-proof accepts a claim receipt as well as the four-field proof. The CLI reads issue_id, incarnation, session_id, and generation.
Claimed issues require an unexpired proof for every requested status change, including unchanged status values.
in_progress requires a held claim proof unless the issue is an epic. Create refuses in_progress for other types.
Force overrides prerequisites only. Closed issues remain claimable. Acquisition does not change status.
Claim acquisition requires --session-id or POLYLINEDB_SESSION_ID. Keep one UUID per caller session.
Claims require the observed store incarnation. Claim timestamps use database Unix seconds, not agent liveness.
TTL defaults to 300 seconds. Agent labels are nullable acquisition metadata, bounded at 64 UTF-8 bytes.
Keepalive stops after --max-duration seconds (default 7200). It exits with the command's code, 0 on release,
5 with claim_lost, and 6 with keepalive_max_duration. It kills the command only with --kill-on-loss.
Retain the claim request UUID, incarnation, session and payload for retries. No automatic retry or reacquisition occurs.
Ready and blocked accept FILTERS except --status. Worklists observe current state; they do not claim work.
The ready worklist leaves out issues labeled main-lock, owner-decision, or owner-action.
Dependency mutations use a separate aggregate revision. Reuse the request UUID and identical payload on retry.
The prefix defaults to repository settings, otherwise pd. It matches [a-z][a-z0-9]{0,15}.
Issue numbers expand with the selected prefix: show 42 reads pd-42, and show 42.1 reads pd-42.1.
Create retries require the same --request-id and identical input. Omission generates a new UUID.
Automatically generated request IDs are not reused by a later CLI invocation.

Examples:
  pd --actor local:agent create --tool compiler --project demo --body 'Fix parser'
  pd show ISSUE_ID
  pd --actor local:agent update ISSUE_ID --body 'New text' --expect body=1
  pd --actor local:agent close ISSUE_ID --expected 1
`;
