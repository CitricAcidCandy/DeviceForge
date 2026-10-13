import assert from 'node:assert/strict';
import { join } from 'node:path';
import { recordContract } from './record-route.mjs';
import { deviceId, shellQuote } from './probe-route.mjs';

// 2026-10-13主代理冻结模板；仅nonce/scid/path/端口是明确受检变量。
const templates = {
  "create": "umask 077; mkdir {dir} && printf '%s\\n' {nonce} > {dir}/owner.token && echo DFPC_VIDEO_CREATED",
  "server": "cat /proc/$$/stat > {dir}/owner.stat && CLASSPATH={dir}/server.jar exec app_process / --nice-name=dfv_{scid} com.genymobile.scrcpy.Server 3.3.1 scid={scid} tunnel_forward=true audio=false control=false max_size=640 max_fps=30 video_bit_rate=2000000 send_device_meta=false send_dummy_byte=false cleanup=false",
  "cleanup": "if [ -e {dir} ]; then [ -d {dir} ] || exit 82; [ \"$(cat {dir}/owner.token)\" = {nonce} ] || exit 92; {await_owner}if [ -f {dir}/owner.stat ]; then saved=$(cat {dir}/owner.stat) || exit 83; p=$(echo \"$saved\" | cut -d ' ' -f 1); case $p in ''|*[!0-9]*) exit 84;; esac; saved_tail=\"${{saved##*) }}\"; set -- $saved_tail; shift 19; expected=$1; owned_state() {{ if [ ! -e /proc/$p/stat ]; then return 1; fi; now=$(cat /proc/$p/stat 2>/dev/null) || {{ [ ! -e /proc/$p/stat ] && return 1; return 2; }}; now_tail=\"${{now##*) }}\"; set -- $now_tail; [ \"${{20}}\" = \"$expected\" ] || return 2; [ \"$1\" = Z ] && return 1; return 0; }}; owned_state; state=$?; [ $state -ne 2 ] || exit 86; if [ $state -eq 0 ]; then name=$(tr '\\000' '\\n' < /proc/$p/cmdline 2>/dev/null | head -n 1); if [ \"$name\" != dfv_{scid} ]; then owned_state; [ $? -eq 1 ] || exit 87; else kill -TERM $p || {{ owned_state; [ $? -eq 1 ] || exit 88; }}; fi; fi; i=0; while :; do owned_state; state=$?; [ $state -eq 1 ] && break; [ $state -eq 0 ] || exit 86; i=$((i+1)); [ $i -le 20 ] || exit 89; sleep 0.05; done; fi; rm -rf {dir} || exit 90; [ ! -e {dir} ] || exit 91; fi; echo DFPC_VIDEO_CLEAN",
  "awaitOwner": "i=0; while [ ! -f {}/owner.stat ]; do i=$((i+1)); [ $i -le 10 ] || exit 81; sleep 0.05; done; "
};
// 后端派生指标2026-10-13冻结：本夹具只有首样，无FPS窗口且无电池观测。
const expectedDerived={api_version:1,cpu_share_percent:null,cpu_core_percent:null,cpu_reason:'首个采样缺少相邻 CPU 计数',fps:null,fps_reason:'未取得主进程展示帧窗口',battery_net_power_mw:null,battery_reason:'未取得设备电池观测'};
const nonce='@VIDEO_TOKEN@', scid='@SCID@';
const directory='/data/local/tmp/df_profile_video_'+nonce;
const render=source=>source.replaceAll('{dir}',directory).replaceAll('{nonce}',nonce).replaceAll('{scid}',scid).replaceAll('{await_owner}',templates.awaitOwner.replace('{}',directory)).replaceAll('{{','{').replaceAll('}}','}');
const script=source=>['-s',deviceId,'shell','-T','/system/bin/sh','-c',shellQuote(source)];
const output=(stdout='',exit=0)=>({stdout:Buffer.from(stdout),stderr:Buffer.alloc(0),exit});
const command=(category,argv,outputs)=>({category,argv,outputs});

function mediaCommands(snapshot,port,options) {
  const row=deviceId+' tcp:'+port+' localabstract:scrcpy_'+scid+'\n';
  const before='DFPC1 8000000000 10000000000 8000002000\n';
  const after=options.drift?'DFPC1 8200000000 10500000000 8200002000\n':'DFPC1 8200000000 10200000000 8200002000\n';
  return [command('media-create',script(render(templates.create)),[output('DFPC_VIDEO_CREATED\n')]),
    ...['server','clock'].map(name=>command('media-push-'+name,['-s',deviceId,'push',join(snapshot,name+'.jar'),directory+'/'+name+'.jar'],[output()])),
    command('media-forward-init',['-s',deviceId,'forward','--no-rebind','tcp:0','localabstract:scrcpy_'+scid],[output(String(port)+'\n')]),
    command('media-server',script(render(templates.server)),[output()]),
    command('media-anchor',script('CLASSPATH='+directory+'/clock.jar app_process / com.deviceforge.profile.ClockAnchor'),[output(before),output(after)]),
    command('media-cleanup',script(render(templates.cleanup)),[output('DFPC_VIDEO_CLEAN\n')]),
    command('media-forward-list',['-s',deviceId,'forward','--list'],[output(options.foreign?'foreign tcp:'+port+' localabstract:foreign\n':row),output(options.foreign?'foreign tcp:'+port+' localabstract:foreign\n':'')]),
    command('media-forward-remove',['-s',deviceId,'forward','--remove','tcp:'+port],[output()])];
}
function scenario(snapshot,port,id,baseId,options={}) {
  const base=recordContract.cases.find(value=>value.id===baseId); assert.ok(base);
  return {...base,id,expected_derived:expectedDerived,kind:options.kind??'record',capture_frames:true,expired_pts:options.expired??false,foreign_forward:options.foreign??false,hold_category:options.hold,
    expected:{...base.expected,frame_count:options.expired||options.drift?0:1,frame_status:options.expired||options.drift?'unavailable':'captured',frame_reason:options.expired?'视频帧与采样目标的时间差超出允许范围':options.drift?'视频与采样时钟映射误差过大':null},
    frame:options.expired||options.drift?null:{index:0,filename:'frames/000000.png',begin_ns:'10054998000',end_ns:'10055002000',source:'scrcpy',epoch:1,video_frame_index:1,pts_us:'8055001',device_time_ns:'10055000000',selection_delta_ns:'0',clock_error_ns:'2000'},
    commands:[...base.commands,...mediaCommands(snapshot,port,options)]};
}
export function mediaContract(snapshot,port,matrix) {
  const cases=matrix==='root'?[scenario(snapshot,port,'media-root','record-adbd-root'),scenario(snapshot,port,'media-no-root','record-no-root')]:matrix==='clock'?[scenario(snapshot,port,'media-expired','record-adbd-root',{expired:true}),scenario(snapshot,port,'media-clock-drift','record-adbd-root',{drift:true})]:matrix==='lifecycle'?[scenario(snapshot,port,'media-cancel','record-adbd-root',{kind:'cancel',hold:'remote-record-receipt'}),scenario(snapshot,port,'media-unload','record-su-root',{kind:'unload',hold:'remote-record-receipt'}),scenario(snapshot,port,'media-reloaded','record-adbd-root',{kind:'reloaded'})]:matrix==='ownership'?[scenario(snapshot,port,'media-forward-foreign','record-adbd-root',{kind:'failed',foreign:true})]:null;
  assert.ok(cases,'PROFILE-MEDIA-MATRIX'); return {...recordContract,cases,route:'持续H264/真实解码/双锚PTS选帧/自有资源清理'};
}
