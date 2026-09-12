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
function part(start, end, reduced,    cmd,i,v,window,kind,amount,after) {
  cmd=base(token[start]); if (cmd !~ /^(cat|less|more|head|tail)$/) return
  for (i=start+1;i<=end;i++) if(op[i] && output(token[i])) return
  if (reduced) return
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
  for(i=start+1;i<=end;i++) {
    v=token[i]
    if(op[i] && redirect(v)) { i++; continue }
    if(!after && v=="--") { after=1; continue }
    if(!after && (v=="-n" || v=="--lines" || v=="-c" || v=="--bytes")) { i++; continue }
    if(v=="-" || (!after && v ~ /^-/)) continue
    print v
  }
}
function segment(start,end,    i,first,reduced,partstart) {
  reduced=0
  for(i=start;i<=end;i++) if(op[i] && (token[i]=="|" || token[i]=="|&") && reducing(base(token[i+1]))) reduced=1
  partstart=start; first=1
  for(i=start;i<=end+1;i++) {
    if(i==end+1 || (op[i] && (token[i]=="|" || token[i]=="|&"))) {
      part(partstart,i-1,first && reduced); partstart=i+1; first=0
    }
  }
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
  push(); start=1
  for(i=1;i<=count+1;i++) {
    if(i==count+1 || (op[i] && (token[i]==";" || token[i]=="&&" || token[i]=="||"))) {
      segment(start,i-1); start=i+1
    }
  }
}
