// Presentation only: keep persisted results and detection rules unchanged.
export function visibleFragment(text) {
  return text.replace(/ /g, '␣').replace(/\t/g, '[制表符]').replace(/\r/g, '[回车]').replace(/\n/g, '[换行]').replace(/[\u200B-\u200D\uFEFF]/g, '[不可见字符]');
}

export function issueGuidance(issue, title = '') {
  const fragments = (issue.spans || []).map(([start, end]) => Array.from(title).slice(start, end).join(''));
  const message = issue.message || '';
  let guide;
  switch (issue.ruleId) {
    case 'T01': guide = ['标题偏长，可以精简', '先删重复修饰词，保留品牌、产品类型和必要规格。150 字符是优化建议，不是发布上限。']; break;
    case 'T02': guide = ['标题较短，检查信息是否齐全', '如果缺少产品类型或关键规格，补上已核实的信息；不要为了凑字数添加卖点。']; break;
    case 'T03':
      if (/认证|效果声明/.test(message)) guide = ['认证或效果说法需要依据', '先核对证书或商品资料。没有依据就删去这段；有依据也需确认该市场允许这样表述。'];
      else if (/网址|邮箱/.test(message)) guide = ['标题里有网址或邮箱', '从标题中移除标出的网址或邮箱，标题只保留描述商品的信息。'];
      else guide = ['标题里有促销或夸大表述', '删去标出的促销用语，保留商品本身的信息。不要换成另一种夸大说法。'];
      break;
    case 'T04': guide = ['普通单词全部用了大写', '把普通单词改为常规大小写，例如 CYCLING BIKE → Cycling Bike；保留品牌原貌及 LCD、USB 等缩写。']; break;
    case 'T05': guide = ['这些符号可能只是装饰', '删去没有实际含义的装饰符号。如果符号属于品牌、型号或规格，核实后保留。']; break;
    case 'T06': guide = ['用竖线「|」分隔了内容', '建议删去竖线，用空格或逗号连接两段内容；如果后一段也要删除，把前面的竖线一起删掉。']; break;
    case 'T07': {
      const unusual = fragments.some(text => /[\t\r\n\u200B-\u200D\uFEFF]/u.test(text));
      guide = unusual
        ? ['标题里有换行或不可见字符', '在下方编辑框中重输标记附近的文字，去掉多余换行、制表符或隐藏字符。“一键整理空格”只处理普通空格。']
        : ['标题里有多余空格', '点下方“一键整理空格”，把连续空格合为一个，并去掉首尾空格。只改修改稿，原标题会保留。'];
      break;
    }
    case 'T08': guide = ['同一个词出现了多次', '读一下标出的词：表达同一意思的重复内容可以合并；属于不同型号或规格的内容要保留。这是本工具的精简建议。']; break;
    case 'T10': guide = /大小写/.test(message)
      ? ['品牌大小写与商品资料不同', '对照品牌官方写法，改正标题或商品资料中写错的一处；不要把品牌统一改为小写。']
      : ['没找到资料中填写的品牌', '先核对商品资料里的品牌名，再检查标题拼写。确认商品有该品牌及使用授权后，再补上准确名称。']; break;
    case 'T11': guide = ['没找到资料中填写的产品类型', '对照商品资料，检查标题是否已有准确的同义说法；如果确实没写产品类型，再补上，不必重复添加。']; break;
    default: guide = [issue.name || '需要人工检查', message || '请对照商品资料核对这条提示。'];
  }
  const positions = issue.ruleId === 'T07'
    ? (issue.spans || []).map(([start, end]) => {
      const chars = Array.from(title);
      return `${start > 12 ? '…' : ''}${chars.slice(Math.max(0, start - 12), Math.min(chars.length, end + 12)).join('')}${end + 12 < chars.length ? '…' : ''}`;
    }) : fragments;
  return { headline: guide[0], action: guide[1], fragments: [...new Set(positions)].map(text => issue.ruleId === 'T07' ? visibleFragment(text) : text) };
}
