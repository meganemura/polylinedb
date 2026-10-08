#!/bin/sh
# Stands in for /usr/bin/security and /usr/bin/secret-tool with the file at PD_AUTH_FIXTURE_STATE.
# A shell, not node: under load, exec of node can outlast the CLI's 30 s credential limit.
state=$PD_AUTH_FIXTURE_STATE
stdin_closed_marker=$1
shift
case $PD_AUTH_FIXTURE_MODE in
  stdin-closed-early) exec 0<&-; : > "$stdin_closed_marker" ;;
  denied) printf %s synthetic-private-token >&2; exit 1 ;;
esac
case " $* " in
  *" find-generic-password "*) [ -e "$state" ] || exit 44; cat "$state"; echo ;;
  *" lookup "*) [ -e "$state" ] || exit 1; cat "$state" ;;
  *" delete-generic-password "* | *" clear "*) rm -f "$state" ;;
  *" search "*) exit 0 ;;
  *)
    umask 077
    input=$(cat; printf x)
    input=${input%x}
    case $input in
      *" -w "*"
") value=${input##* -w }; value=${value%?} ;;
      *) value=$input ;;
    esac
    printf %s "$value" > "$state"
    ;;
esac
