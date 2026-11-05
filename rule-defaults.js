/**
 * Built-in MDT guard rule catalog.
 *
 * This module is dependency-free and side-effect free: it only defines the
 * frozen rule metadata shared by configuration validation and rule
 * compilation. Every source is a regular-expression source string compiled
 * with `RULE_REGEX_FLAGS`.
 */

export const RULE_REGEX_FLAGS = 'i';

export const HARD_DENY_RULES = Object.freeze([
  Object.freeze({
    id: 'hard-deny.prompt-injection',
    category: 'H',
    source: String.raw`(忽略|无视|忘记|忘掉|跳过|绕过|不要遵守|别管|不要管|不用管|不必遵守).{0,8}(指令|规则|提示词|提示|系统提示|内部规则|安全策略|内容政策|设定|(?:你的|你们的|系统|安全|内容)(?:限制|约束))|(?:ignore|disregard|forget|bypass|override|skip).{0,24}(?:previous|prior|above|earlier|all|any|system|your).{0,24}(?:instructions?|rules?|prompts?|constraints?|guidelines?)`,
  }),
  Object.freeze({
    id: 'hard-deny.role-switch',
    category: 'H',
    source: String.raw`(?:(?:扮演|假装|充当).{0,6}(?:医生|专家|护士|黑客|角色|助手|AI|模型)|(?:切换|更换)角色|作为.{0,6}(?:角色|AI|人工智能|模型|黑客)|(?:变成|你现在是|从现在开始你是).{0,6}(?:角色|助手|AI|人工智能|模型|黑客))|(?:act\s+as|pretend\s+to\s+be|you\s+are\s+now).{0,24}(?:doctor|expert|hacker|assistant|model|role|\bai\b)`,
  }),
  Object.freeze({
    id: 'hard-deny.system-prompt-exfiltration',
    category: 'H',
    source: String.raw`(导出|输出|显示|打印|告诉我|泄露|透露|复述|重复|列出|读取|查看|打开|获取|给我|发我).{0,8}(系统提示词|系统提示|系统指令|内部规则|内部指令|隐藏指令|初始指令|(?:你的|你们的)(?:系统)?(?:规则|指令|提示词))|(?:show|print|reveal|dump|repeat|tell\s+me|give\s+me|read|export).{0,16}(?:system\s*prompt|internal\s*(?:rules?|instructions?)|your\s+(?:rules?|instructions?|prompt))`,
  }),
  Object.freeze({
    id: 'hard-deny.any-question-permission',
    category: 'H',
    source: String.raw`(现在|从此|以后|接下来).{0,6}(可以|能|允许|尽管).{0,6}(回答|处理|讨论|聊).{0,6}(任何|所有|一切|任意).{0,6}(问题|话题|内容|提问|请求|领域|题目)|(?:from\s+now\s+on|\bnow\b|you\s+can).{0,24}(?:answer|discuss|handle|talk\s+about).{0,16}(?:anything|everything|any\s+topic|all\s+questions)`,
  }),
  Object.freeze({
    id: 'hard-deny.jailbreak',
    category: 'H',
    source: String.raw`(jailbreak|DAN\s*mode|越狱模式|无限制模式)`,
  }),
  Object.freeze({
    id: 'hard-deny.sensitive-path',
    category: 'G',
    source: String.raw`(~\/\.dsh|~\/\.ssh|\/root(?:\/|\b)|\.dsh\/(?:mdt|profiles|sessions)|\/etc\/dsh|\/etc\/(?:passwd|shadow)|\.ssh\/|id_rsa|dsh\s*(?:安装|部署)?\s*目录|dsh\s+install(?:ation)?\s+(?:dir|path))`,
  }),
  Object.freeze({
    id: 'hard-deny.read-sensitive',
    category: 'G',
    source: String.raw`(读取|查看|看看|看下|看一下|瞅瞅|查一下|查下|打印|输出|显示|导出|列出|打开|获取|给我|发我|读出|贴出来|dump|cat|echo|print|show|read|list|export|give\s+me).{0,12}(配置(?!好?(?:的)?(?:药液|药水|药品|药物|药剂|药膏|液体|溶液|输液|盐水|葡萄糖))|config(?:\.json)?|guard\.json|settings\.ya?ml|\.env|环境变量|env(?:ironment)?\s*(?:vars?|variables?)|日志|log(?:s)?|令牌|token|密钥|secret|api\s*key|证书|cert(?:ificate)?)`,
  }),
  Object.freeze({
    id: 'hard-deny.read-sensitive-reverse',
    category: 'G',
    source: String.raw`(配置(?:文件|项|参数)|config(?:\.json)?|guard\.json|settings\.ya?ml|\.env|环境变量|日志|令牌|token|密钥|secret|api\s*key|证书|cert(?:ificate)?).{0,12}(在哪|在哪里|位置|路径|内容|打印|输出|读取|查看|打开|发我|给我|导出|dump|cat|show|read|list|export)`,
  }),
  Object.freeze({
    id: 'hard-deny.command-exec',
    category: 'G',
    source: String.raw`(执行|运行|运行一下|敲|输入|调用|启动|开启|打开).{0,8}(命令|指令|shell|bash|zsh|powershell|cmd|终端|terminal|命令行|脚本)|(?:run|execute|open|launch|start).{0,16}(?:command|shell|bash|zsh|powershell|cmd|terminal|script)`,
  }),
  Object.freeze({
    id: 'hard-deny.software-install',
    category: 'G',
    source: String.raw`(安装|卸载|重装|升级|降级).{0,8}(软件|程序|应用|依赖|dsh|node|npm|pnpm|yarn|pip|python|java)|(?:install|uninstall|reinstall|upgrade|downgrade).{0,16}(?:software|package|dependency|dsh|node|npm|pnpm|yarn|pip|python|java)|(?:npm|pnpm|yarn|pip)\s+(?:install|add|remove|uninstall)`,
  }),
  Object.freeze({
    id: 'hard-deny.config-modify',
    category: 'G',
    source: String.raw`(修改|更改|改一下|改掉|改|编辑|写入|覆盖|删除|删掉|清空|重置|更新).{0,12}(配置(?!好?(?:的)?(?:药液|药水|药品|药物|药剂|药膏|液体|溶液|输液|盐水|葡萄糖))(?:文件|项|参数)?|config(?:\.json)?|guard\.json|settings\.ya?ml|插件配置|系统配置|环境变量|\.env|系统设置|注册表|日志|HIS\s*(?:地址|配置))|(?:modify|change|edit|write|overwrite|delete|clear|reset|update).{0,16}(?:config(?:\.json)?|guard\.json|settings\.ya?ml|environment\s*variables?|registry|\.env|logs?)`,
  }),
  Object.freeze({
    id: 'hard-deny.service-ops',
    category: 'G',
    source: String.raw`(?:重启|启动|停止|关闭|杀掉)(?:.{0,8}(?:服务|进程|插件|dsh|操作系统|主机|服务器|容器)|\s*(?:(?:一下|下|所有|全部|整个|该|本|当前|本机|本地|远程|这台|那台)\s*)?系统(?=$|\s*(?:[!！。,.，?？;；:：、~～…]|吧|啊|了|呢|呀|嘛|呗|并|后|再|然后|之后|服务|进程|配置|设置|日志|故障|异常|错误|文件|目录|环境)))|(?:排查|调试|诊断|修复).{0,8}(?:服务|进程|插件|dsh|主机|服务器|容器|操作系统|系统故障|系统异常|系统错误|系统服务|系统进程|系统配置|系统设置|系统日志|系统环境|系统文件|系统目录)|(?:restart|start|stop|kill|debug|diagnose|fix).{0,16}(?:service|process(?!\s+(?:of|for)\b)|plugin|dsh|server|container|host)`,
  }),
]);

export const FAST_ALLOW_RULES = Object.freeze([
  Object.freeze({
    id: 'fast-allow.greeting',
    category: 'D',
    source: String.raw`^(你好|您好|嗨|哈喽|hi|hello|hey|早上好|上午好|中午好|下午好|晚上好|在吗|在不在|大家好)(?:呀|啊)?[\s!！。,.，~～?？、]*$`,
  }),
  Object.freeze({
    id: 'fast-allow.continuation',
    category: 'D',
    source: String.raw`^(好的?|好滴|好嘞|行|可以|嗯+|哦+|噢+|收到|明白(?:了)?|了解(?:了)?|知道(?:了)?|清楚(?:了)?|继续|请继续|接着(?:说|讲)?|接着说(?:下去)?|然后呢|展开(?:说说|讲讲|一下)?|详细(?:说说|讲讲)?|谢谢|多谢|感谢|辛苦了?|拜拜|再见)(?:啦|呀|啊|呢|吧)?[\s!！。,.，~～?？、]*$`,
  }),
  Object.freeze({
    id: 'fast-allow.software-help',
    category: 'C',
    source: String.raw`(插件|本软件|这个软件|该软件|平台|界面|按钮|菜单|页面|PPT|演示文稿|版本|安装包|客户端|网页|登录页).{0,12}(怎么|如何|怎样|在哪|哪里|哪儿|咋)`,
  }),
  Object.freeze({
    id: 'fast-allow.software-help',
    category: 'C',
    source: String.raw`^(怎么|如何|怎样|咋)(登录|下载|安装|更新|升级|导出|预览|生成|打开|使用|操作|注册|找回密码)[\s!！。,.，~～?？、]*(这个|本)?(插件|软件|系统|平台|PPT|客户端|账号|密码|版本)?[\s!！。,.，~～?？、]*$`,
  }),
  Object.freeze({
    id: 'fast-allow.software-help',
    category: 'C',
    source: String.raw`(插件|软件|平台|PPT|版本|按钮|界面).{0,12}(怎么用|如何使用|在哪下载|在哪里下载|怎么下载|怎么安装|怎么更新|怎么升级|怎么登录|怎么导出|怎么预览|怎么生成|怎么打开|怎么设置|怎么配置|支持哪些|有什么功能)`,
  }),
  Object.freeze({
    id: 'fast-allow.software-help',
    category: 'C',
    source: String.raw`^(在哪里|在哪|哪里|哪儿|怎么|如何|怎样)(可以)?[\s]*(把|将)?[\s]*(登录|下载|安装|更新|升级|导出|预览|生成|打开|使用|操作)[\s]*(这个|本)?[\s]*(插件|软件|系统|平台|PPT|客户端|账号|密码|版本)?[\s!！。,.，~～?？、]*$`,
  }),
  Object.freeze({
    id: 'fast-allow.software-help',
    category: 'C',
    source: String.raw`^(怎么|如何|怎样)(把|将).{0,8}(导出|预览|生成|下载|打开|更新|升级)`,
  }),
]);

export const HARD_DENY_DEFAULT_SOURCES = Object.freeze(
  HARD_DENY_RULES.map((rule) => rule.source),
);

export const FAST_ALLOW_DEFAULT_SOURCES = Object.freeze(
  FAST_ALLOW_RULES.map((rule) => rule.source),
);

const BUILT_IN_SOURCE_SET = new Set([
  ...HARD_DENY_DEFAULT_SOURCES,
  ...FAST_ALLOW_DEFAULT_SOURCES,
]);

/**
 * Whether a source is an exact built-in source from either catalog.
 *
 * Exact built-in sources are exempt from the normalization-stability guard
 * because some legitimately contain full-width punctuation that NFKC folds.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function isBuiltInRuleSource(source) {
  return BUILT_IN_SOURCE_SET.has(source);
}

// Evaluation erases every Unicode `Cf` format character and the variation
// selectors U+FE00-U+FE0F. Global because it is used only with
// `String#replace` (never with `.test`), and written with escapes so no
// invisible literal lives in this file. The mutable object is not exported.
const FORMAT_CHARACTERS = /[\p{Cf}\uFE00-\uFE0F]/gu;

/**
 * Remove the format characters that evaluation normalization erases.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFormatCharacters(text) {
  return text.replace(FORMAT_CHARACTERS, '');
}

/**
 * Replace the format characters that evaluation normalization erases with a
 * single space.
 *
 * Erasing a format character that separates two English tokens would merge
 * them (`give<Cf>me` becomes `giveme`), so evaluation also matches a variant
 * where each format character is treated as a token separator.
 *
 * @param {string} text
 * @returns {string}
 */
export function replaceFormatCharactersWithSpace(text) {
  return text.replace(FORMAT_CHARACTERS, ' ');
}

// Non-global where `.test` is used so repeated calls never depend on
// `lastIndex`.
const LITERAL_FORMAT_CHARACTER = /[\p{Cf}\uFE00-\uFE0F]/u;
const WHITESPACE_CHARACTER = /[\s\u0085]/u;
const FORMAT_CATEGORY_CHARACTER = /\p{Cf}/u;
const VARIATION_SELECTOR = /[\uFE00-\uFE0F]/u;
const WHITESPACE_ONLY = /^[\s\u0085]*$/;

/**
 * Whether a source is empty or contains only whitespace.
 *
 * `\s` and `String#trim()` both miss U+0085 (NEL), so the predicate names it
 * explicitly. Shared by `config.js` and `rules.js` so both entry points reject
 * exactly the same sources.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function isWhitespaceOnlySource(source) {
  return WHITESPACE_ONLY.test(source);
}

// Global scanner used only with `String#matchAll`, which does not mutate the
// regex `lastIndex`. Captures the target of `\uXXXX`, `\u{...}`, `\xXX`,
// single-letter control escapes, control-letter escapes (`\cI`), octal
// escapes (`\012`) and the `\p{Cf}` / `\P{Cf}` / `\p{C}` / `\P{C}` category
// escapes. Numeric backreferences `\1`-`\9` are intentionally not analysed:
// they are ambiguous with legacy octal escapes and out of scope for this
// simple stability check.
const ESCAPE_SCAN =
  /\\(?:u\{([0-9A-Fa-f]+)}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|([tnrfv])|c([A-Za-z])|0([0-7]{1,2})|[pP]\{(Cf|C)})/g;

function hasOddPrecedingBackslashes(source, index) {
  let count = 0;
  for (let position = index - 1; position >= 0 && source[position] === '\\'; position -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function isUnstableCodePoint(codePoint) {
  if (codePoint > 0x10ffff) {
    return true;
  }
  const character = String.fromCodePoint(codePoint);
  return (
    FORMAT_CATEGORY_CHARACTER.test(character) ||
    VARIATION_SELECTOR.test(character) ||
    (codePoint !== 0x0020 && WHITESPACE_CHARACTER.test(character)) ||
    character.normalize('NFKC') !== character
  );
}

function hasUnstableEscape(source) {
  for (const match of source.matchAll(ESCAPE_SCAN)) {
    if (hasOddPrecedingBackslashes(source, match.index)) {
      continue;
    }
    const [, braced, unicode, hex, control, controlLetter, octal, category] = match;
    if (control !== undefined || category !== undefined) {
      return true;
    }
    let codePoint;
    if (braced !== undefined) {
      codePoint = Number.parseInt(braced, 16);
    } else if (unicode !== undefined) {
      codePoint = Number.parseInt(unicode, 16);
    } else if (hex !== undefined) {
      codePoint = Number.parseInt(hex, 16);
    } else if (controlLetter !== undefined) {
      // A control-letter escape encodes the letter's code point in its low
      // five bits, so `\cI` targets U+0009 (tab) and `\cM` targets U+000D.
      codePoint = controlLetter.toUpperCase().charCodeAt(0) & 0x1f;
    } else {
      codePoint = Number.parseInt(octal, 8);
    }
    if (isUnstableCodePoint(codePoint)) {
      return true;
    }
    // U+0020 is meaningful only between tokens. Input is trimmed before
    // matching, so an escaped space at a source boundary, directly after a
    // leading `^`, or directly before a trailing `$` can never match. This is
    // deliberately conservative: it checks only direct anchor-adjacent
    // positions, not arbitrary nesting such as `(?:^\x20)`. Numeric
    // backreferences remain out of scope.
    if (codePoint === 0x0020) {
      const escapeEnd = match.index + match[0].length;
      if (
        match.index === 0 ||
        escapeEnd === source.length ||
        (match.index === 1 && source[0] === '^') ||
        (escapeEnd === source.length - 1 && source[source.length - 1] === '$')
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasInertLiteralWhitespace(source) {
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!WHITESPACE_CHARACTER.test(character)) {
      continue;
    }
    if (character !== '\u0020') {
      return true;
    }
    const previous = index > 0 ? source[index - 1] : undefined;
    const next = index + 1 < source.length ? source[index + 1] : undefined;
    if (previous === '\u0020' || next === '\u0020') {
      return true;
    }
    if (previous === undefined || next === undefined) {
      return true;
    }
    // An escaped space as the very first character (`\ foo`) is inert for the
    // same trimming reason; an escaped internal space (`a\ b`) stays valid.
    if (index === 1 && source[0] === '\\') {
      return true;
    }
    // A space directly inside a leading `^` or trailing `$` anchor would be
    // trimmed away (for example `^ foo$`); `[^ ]` stays accepted because
    // only the anchors at the very start and very end are checked.
    if (index === 1 && source[0] === '^') {
      return true;
    }
    if (index === source.length - 2 && source[source.length - 1] === '$') {
      return true;
    }
  }
  return false;
}

/**
 * Whether a custom regex source stays meaningful under message normalization.
 *
 * Evaluation NFKC-folds text, erases every Unicode `Cf` format character and
 * the variation selectors `U+FE00`-`U+FE0F`, collapses whitespace and trims.
 * A source containing a literal format character, a variation selector,
 * literal whitespace other than a single internal `U+0020`, or a regex escape
 * targeting one of those code points cannot behave as written against
 * normalized input, so configuration rejects it rather than compiling a
 * silently inert rule. An escaped `U+0020` is likewise rejected at the very
 * start or end of the source, directly after a leading `^`, or directly
 * before a trailing `$`, because input is trimmed before matching; an internal
 * escaped space such as `a\x20b` stays meaningful. Escape scanning respects
 * backslash parity, so an escaped backslash followed by `u200B` text stays
 * stable. Numeric backreferences `\1`-`\9` are intentionally not analysed
 * because they are ambiguous with legacy octal escapes.
 *
 * This check is conservative: it does not prove that a source can match,
 * arbitrary regex semantics are not fully analysed, and only direct
 * anchor-adjacent escaped spaces are detected (not arbitrary nesting such as
 * `(?:^\x20)`).
 *
 * @param {string} source
 * @returns {boolean} `true` when the source contains no literal character or
 *   escape target that normalization erases or folds
 */
export function isNormalizationStableSource(source) {
  return (
    !LITERAL_FORMAT_CHARACTER.test(source) &&
    !hasInertLiteralWhitespace(source) &&
    !hasUnstableEscape(source) &&
    source.normalize('NFKC') === source
  );
}
