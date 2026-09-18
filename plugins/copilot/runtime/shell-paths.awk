# Small lexical recognizer for direct file readers, never a shell evaluator.
# Unsupported expansions stay literal; malformed quoting produces no candidates.
function push() { if (word != "") { token[++count]=word; op[count]=0; word="" } }
function operator(value) { push(); token[++count]=value; op[count]=1 }
function base(value) { sub(/^.*\//,"",value); return tolower(value) }
function reducing(value) { return value ~ /^(grep|rg|head|tail|wc)$/ }
function redirect(value) { return value ~ /^(>|>>|1>|1>>|2>|2>>|&>|&>>)$/ }
function output(value) { return value ~ /^(>|>>|1>|1>>|&>|&>>)$/ }
function small(value, ceiling) {
  # +N means from N to EOF, not N lines. Reject ambiguous suffixes conservatively.
  if (value !~ /^[0-9]+$/) return 0
  sub(/^-/,"",value); return (value+0 <= ceiling)
}
# Dumpers the hook cannot size by looking at a path: printed as "!unbounded<TAB>description"
# (denied outright) or "!git<TAB>subcommand<SOH>args" (sized with git --numstat, no pager, no lock).
function dumper(start,end,    cmd,i,v,s,patch,bounded,args,exec) {
  cmd=base(token[start])
  if(cmd=="git") {
    i=start+1
    while(i<=end && token[i] ~ /^-/) { if(token[i]=="-C" || token[i]=="-c") i++; i++ }
    s=token[i]; i++
    if(s=="log") {
      for(;i<=end;i++) { v=token[i]; if(op[i]) break
        if(v ~ /^(-p|--patch|-u)$/) patch=1
        if(v ~ /^(-n|--max-count)$/ || v ~ /^-n[0-9]+$/ || v ~ /^--max-count=/ || v ~ /^-[0-9]+$/) bounded=1 }
      if(patch && !bounded) print "!unbounded\tgit log -p (the whole history with every diff)"
      return 1
    }
    if(s=="diff" || s=="show") {
      args=""
      for(;i<=end;i++) { v=token[i]; if(op[i]) break
        if(v ~ /^(--stat|--numstat|--shortstat|--name-only|--name-status|--dirstat|--summary|--no-patch|-s|--check|--raw|--quiet|--exit-code|--stat=.*|--dirstat=.*)$/) return 1
        if(v ~ /^(-p|--patch|-u|--no-stat|--color|--no-color)$/) continue
        if(s=="show" && v !~ /^-/ && v ~ /:/) return 1
        args=args "\002" v }
      print "!git\t" s args
      return 1
    }
    return 1
  }
  if(cmd=="find") {
    for(i=start+1;i<=end;i++) if(token[i] ~ /^-(exec|execdir|ok|okdir)$/ && base(token[i+1]) ~ /^(cat|less|more)$/) {
      print "!unbounded\tfind ... -exec cat (every file it finds, in full)"; return 1 }
    return 1
  }
  if(cmd=="xargs") {
    for(i=start+1;i<=end;i++) { v=token[i]
      if(v ~ /^-(n|I|P|d|L|s|E)$/) { i++; continue }
      if(v ~ /^-/) continue
      if(base(v) ~ /^(cat|less|more)$/) print "!unbounded\txargs cat (every listed file, in full)"
      return 1 }
    return 1
  }
  return 0
}
function part(start, end, reduced,    cmd,i,v,window,kind,amount,after) {
  if(start>end) return
  for (i=start+1;i<=end;i++) if(op[i] && output(token[i])) return
  if (reduced) return
  if (dumper(start,end)) return
  cmd=base(token[start]); if (cmd !~ /^(cat|less|more|head|tail)$/) return
  if (cmd == "head" || cmd == "tail") {
    kind="lines"; amount="10"
    for(i=start+1;i<=end;i++) {
      v=token[i]
      if(v=="--") break
      if(v=="-n" || v=="--lines") { amount=token[i+1]; break }
      if(v=="-c" || v=="--bytes") { kind="bytes"; amount=token[i+1]; break }
      if(v ~ /^-[0-9]+$/) { amount=substr(v,2); break }
      if(v ~ /^-n.+$/) { amount=substr(v,3); break }
      if(v ~ /^-c.+$/) { kind="bytes"; amount=substr(v,3); break }
      if(v ~ /^--lines=/) { amount=substr(v,9); break }
      if(v ~ /^--bytes=/) { kind="bytes"; amount=substr(v,9); break }
    }
    if(small(amount,kind=="lines"?max_lines:max_bytes)) return
  }
  after=0
  print "!part\t" cmd
  for(i=start+1;i<=end;i++) {
    v=token[i]
    if(op[i] && redirect(v)) { i++; continue }
    if(!after && v=="--") { after=1; continue }
    if(!after && (v=="-n" || v=="--lines" || v=="-c" || v=="--bytes")) { i++; continue }
    if(v=="-" || (!after && v ~ /^-/)) continue
    print v
  }
}
# A part is reduced when a later stage of its pipeline is a reducer (grep, head, wc ...).
function segment(start,end,    i,j,reduced,partstart) {
  partstart=start
  for(i=start;i<=end+1;i++) {
    if(i==end+1 || (op[i] && (token[i]=="|" || token[i]=="|&"))) {
      reduced=0
      for(j=i;j<=end;j++) if(op[j] && (token[j]=="|" || token[j]=="|&") && reducing(base(token[j+1]))) reduced=1
      part(partstart,i-1,reduced); partstart=i+1
    }
  }
}
# Read-only classification for a worker's shell (classify=1): prints "write" when any part could
# change the workspace, "read" otherwise. Unknown commands are writes: a worker has no business
# running them. Command substitution is a write for the same reason.
function readonly_git(i,end,    s,j) {
  while(i<=end && token[i] ~ /^-/) { if(token[i]=="-C" || token[i]=="-c") i++; i++ }
  s=token[i]
  if(s ~ /^(log|diff|show|status|blame|ls-files|ls-tree|grep|rev-parse|describe|shortlog|cat-file|name-rev|reflog|stash|remote|tag|branch)$/) {
    for(j=i+1;j<=end;j++) {
      if(op[j]) continue
      if(s=="branch" && token[j] !~ /^(-a|-r|-v|-vv|--list|--show-current|--all|--remotes|--contains|--merged|--no-merged)$/) return 0
      if(s=="remote" && token[j] !~ /^(-v|show)$/) return 0
      if(s=="tag" && token[j] !~ /^(-l|--list|-n[0-9]*)$/) return 0
      if(s=="stash" && token[j] !~ /^(list|show)$/) return 0
      if(s=="reflog" && token[j] !~ /^(show|-)/) return 0
    }
    return 1
  }
  return 0
}
function readonly_command(start,end,    cmd,i,v) {
  if(start>end) return 1
  cmd=base(token[start])
  if(cmd ~ /^(cat|head|tail|less|more|grep|rg|egrep|fgrep|find|ls|tree|wc|awk|sort|uniq|cut|tr|diff|file|stat|du|pwd|echo|printf|which|type|basename|dirname|realpath|readlink|cd|true|test|\[|nl|column|strings|od|xxd|hexdump|date|uname|jq|yq)$/) {
    if(cmd=="find") for(i=start+1;i<=end;i++) {
      v=token[i]
      if(v=="-delete") return 0
      if(v ~ /^-(exec|execdir|ok|okdir)$/) return readonly_command(i+1,end)
    }
    return 1
  }
  if(cmd=="sed") { for(i=start+1;i<=end;i++) if(token[i] ~ /^-[a-zA-Z]*i/ || token[i] ~ /^--in-place/) return 0; return 1 }
  if(cmd=="xargs" || cmd=="env" || cmd=="nice" || cmd=="time" || cmd=="command") {
    for(i=start+1;i<=end;i++) {
      v=token[i]
      if(v ~ /^-(n|I|P|d|L|s|E)$/) { i++; continue }
      if(v ~ /^-/ || (cmd=="env" && v ~ /=/)) continue
      return readonly_command(i,end)
    }
    return cmd=="env"
  }
  if(cmd=="git") return readonly_git(start+1,end)
  return 0
}
function classification(    i,start,partstart,target) {
  for(i=1;i<=count;i++) {
    if(!op[i] && (token[i] ~ /\$\(/ || token[i] ~ /`/)) return "write"
    if(op[i] && redirect(token[i])) { target=token[i+1]; if(target!="/dev/null" && target !~ /^&/) return "write" }
  }
  partstart=1
  for(i=1;i<=count+1;i++) {
    if(i==count+1 || (op[i] && token[i] ~ /^(;|&&|\|\||\||\|&)$/)) {
      start=partstart
      while(start<i && op[start]) start++
      if(!readonly_command(start,i-1)) return "write"
      partstart=i+1
    }
  }
  return "read"
}
{ source=source $0 "\n" }
END {
  for(i=1;i<=length(source);i++) {
    c=substr(source,i,1); n=substr(source,i+1,1)
    if(escaped) { if(c!="\n") word=word c; escaped=0; continue }
    if(c=="\\" && quote!="\047") { escaped=1; continue }
    if(quote!="") {
      if(c=="\n") exit 0
      if(c==quote) quote=""; else word=word c
      continue
    }
    if(c=="\047" || c=="\042") { quote=c; continue }
    if(c=="\n") { operator(";"); continue }
    if(c ~ /[ \t\r]/) { push(); continue }
    if(c ~ /^[012]$/ && n==">") {
      push(); v=c ">"; i++; if(substr(source,i+1,1)==">") {v=v ">";i++}; operator(v); continue
    }
    pair=c n
    if(pair=="&&" || pair=="||" || pair==">>" || pair=="|&" || pair=="&>") {
      i++; if(pair=="&>" && substr(source,i+1,1)==">") {pair="&>>";i++}; operator(pair); continue
    }
    if(c==";" || c=="|" || c==">") { operator(c); continue }
    word=word c
  }
  if(quote!="" || escaped) exit 0
  push()
  if(classify) { print classification(); exit 0 }
  start=1
  for(i=1;i<=count+1;i++) {
    if(i==count+1 || (op[i] && (token[i]==";" || token[i]=="&&" || token[i]=="||"))) {
      segment(start,i-1); start=i+1
    }
  }
}
