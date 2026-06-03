'use strict';

// Centralized alert detection rules
// Edit this file to change what triggers alerts across both backend and frontend

const DANGEROUS_PATTERNS = [
  'rm\\s',                           // 所有 rm 操作
  'mkfs',                            // 格式化磁盘
  'dd\\s+if=.*of=\\/dev\\/',         // 磁盘覆写
  'shutdown',                        // 关机
  'reboot',                          // 重启
  'curl.*\\|\\s*(?:bash|sh)',        // 远程代码执行
  'wget.*\\|\\s*(?:bash|sh)',        // 远程代码执行
];

const EXFIL_PATTERNS = [
  'while.*curl',                     // 循环请求 (DoS)
  'for.*curl.*done',                 // 循环请求 (DoS)
  'nc\\s+-l',                        // 开监听端口
  'ncat\\s+-l',                      // 开监听端口
  'bash\\s+-i\\s+>.*\\/dev\\/tcp',   // 反弹 shell
];

const DANGEROUS_RE = new RegExp(DANGEROUS_PATTERNS.join('|'), 'i');
const EXFIL_RE = new RegExp(EXFIL_PATTERNS.join('|'), 'i');

module.exports = {
  DANGEROUS_PATTERNS,
  EXFIL_PATTERNS,
  DANGEROUS_RE,
  EXFIL_RE,
};
