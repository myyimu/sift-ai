// 步骤 1–4 抽取规则测试（P0_DEMO_SCOPE §2.4 六步规则前四步）。
// 输入为内联 HTML 片段（避免反向依赖 extension 代码；真实脱敏 HTML 由 e2e 覆盖）。
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { extractBlocks, normalizeBlockText } from '../src/extract'

const LONG = '这是一段超过二十个非空白字符的正文内容，用于通过普通块的最低门槛检查。'
const SHORT = '太短'

function htmlOf(bodyInner: string): string {
  return `<html><head><title>t</title></head><body>${bodyInner}</body></html>`
}

describe('步骤 1：剥离', () => {
  it('各族剥离标签的文本不出现（script/style/nav/footer/控件/媒体）', () => {
    const blocks = extractBlocks(htmlOf(`
      <main>
        <script>var x = 'secret';</script>
        <style>.a { color: red }</style>
        <template><p>模板内容不应出现模板内容不应出现</p></template>
        <noscript><p>noscript 内容不应出现 noscript 内容不应出现</p></noscript>
        <nav><a href="/x">导航链接导航链接导航链接导航链接</a></nav>
        <header><p>页眉内容页眉内容页眉内容页眉内容页眉内容</p></header>
        <footer><p>页脚内容页脚内容页脚内容页脚内容页脚内容</p></footer>
        <aside><p>侧栏内容侧栏内容侧栏内容侧栏内容侧栏内容</p></aside>
        <form><input value="秘密"><button>提交按钮提交按钮提交按钮</button></form>
        <dialog><p>对话框内容对话框内容对话框内容对话框内容</p></dialog>
        <iframe src="https://x.example/frame"></iframe>
        <svg><text>svg 文本 svg 文本 svg 文本 svg 文本</text></svg>
        <video><source src="https://x.example/v"></video>
        <p>${LONG}</p>
      </main>`))
    const text = blocks.map(b => b.text).join('\n')
    expect(text).toContain(LONG)
    for (const banned of ['secret', '导航链接', '页眉内容', '页脚内容', '侧栏内容', '提交按钮', '对话框内容', 'svg 文本', '模板内容', 'noscript 内容']) {
      expect(text).not.toContain(banned)
    }
  })

  it('hidden / aria-hidden / 噪声 role / aria-modal 剥离', () => {
    const blocks = extractBlocks(htmlOf(`
      <main>
        <p hidden>${LONG}</p>
        <p aria-hidden="true">${LONG}</p>
        <div role="navigation"><p>${LONG}</p></div>
        <div role="banner"><p>${LONG}</p></div>
        <div role="search"><p>${LONG}</p></div>
        <div aria-modal="true"><p>${LONG}</p></div>
        <p>${LONG}</p>
      </main>`))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toBe(LONG)
  })
})

describe('步骤 2：根选择', () => {
  it('eligible text 最多的 main 胜出；并列取文档序第一个', () => {
    const blocks = extractBlocks(htmlOf(`
      <main><p>${LONG}（甲）</p></main>
      <main><p>${LONG}（乙）</p><p>${LONG}（乙二）</p></main>
      <p>main 外的正文不会被收割 main 外的正文不会被收割</p>`))
    const text = blocks.map(b => b.text).join('|')
    expect(text).toContain('（乙）')
    expect(text).toContain('（乙二）')
    expect(text).not.toContain('（甲）')
    expect(text).not.toContain('main 外')
  })

  it('无 main：过门槛的顶层 article 胜出（nav 噪声不干扰）', () => {
    const blocks = extractBlocks(htmlOf(`
      <nav><a href="/">首页首页首页首页首页首页首页首页</a></nav>
      <article><h1>文章标题</h1><p>${LONG}</p></article>`))
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'paragraph'])
    expect(blocks[1]!.text).toBe(LONG)
  })

  it('无 main 无过门槛 article：去噪 body 兜底', () => {
    const blocks = extractBlocks(htmlOf(`
      <article><p>${SHORT}</p></article>
      <div><p>${LONG}（正文）</p></div>`))
    expect(blocks.map(b => b.text)).toEqual([`${LONG}（正文）`])
  })
})

describe('步骤 3：块生成', () => {
  it('各块类型按 DOM 序（heading/paragraph/quote/code/table/list_item/剩余连续文本）', () => {
    const blocks = extractBlocks(htmlOf(`
      <main>
        <h2>二级标题</h2>
        <p>${LONG}</p>
        <blockquote>${LONG}（引）</blockquote>
        <pre><code>const answer = 42; // 代码块内容足够长</code></pre>
        <table><tbody>
          <tr><td>第一季度营收数据摘要</td><td>第二季度营收数据摘要</td></tr>
          <tr><td>第三季度营收数据摘要</td><td>第四季度营收数据摘要</td></tr>
        </tbody></table>
        <ul><li>列表项一的完整说明内容超过二十个字符说明</li><li>列表项二的完整说明内容超过二十个字符说明</li></ul>
        <div>直接裸文本甲直接裸文本甲直接裸文本甲<span>与内联文本乙</span></div>
      </main>`))
    expect(blocks.map(b => b.kind)).toEqual([
      'heading', 'paragraph', 'quote', 'code', 'table', 'table', 'list_item', 'list_item', 'paragraph',
    ])
    expect(blocks[0]!.text).toBe('二级标题')
    expect(blocks[4]!.text).toBe('第一季度营收数据摘要 第二季度营收数据摘要') // tr：单元格单空格连接
    expect(blocks[8]!.text).toBe('直接裸文本甲直接裸文本甲直接裸文本甲与内联文本乙') // 连续剩余文本（内联透传合并）
    expect(blocks.map(b => b.ordinal)).toEqual([...blocks.keys()])
  })

  it('嵌套块不重复计（p 内 span/li 内嵌列表并入外层文本）', () => {
    const blocks = extractBlocks(htmlOf(`
      <main>
        <p>外层段落的完整内容外层段落<strong>加粗内联补充文本</strong><span>跨度内联</span></p>
        <ul><li>外层列表项外层列表项外层列表项<ul><li>内层列表项内层列表项</li></ul></li></ul>
      </main>`))
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.text).toBe('外层段落的完整内容外层段落加粗内联补充文本跨度内联')
    expect(blocks[1]!.text).toContain('外层列表项')
    expect(blocks[1]!.text).toContain('内层列表项') // 并入外层 li，不单独成块
  })
})

describe('步骤 4：门槛', () => {
  it('heading 只要求非空；其余 >= 20 非空白字符', () => {
    const blocks = extractBlocks(htmlOf(`
      <main>
        <h3>短标题也保留</h3>
        <h4></h4>
        <h5>   </h5>
        <p>${SHORT}</p>
        <p>${LONG}</p>
      </main>`))
    expect(blocks.map(b => [b.kind, b.text] as const)).toEqual([['heading', '短标题也保留'], ['paragraph', LONG]])
  })

  it('归一化：NFC + 空白折叠 + trim（跨行/多空格文本）', () => {
    const raw = '  第一行的内容\n\t第二行的内容   还有\t更多多空格结尾  '
    expect(normalizeBlockText(raw)).toBe('第一行的内容 第二行的内容 还有 更多多空格结尾')
    const blocks = extractBlocks(htmlOf(`<main><p>  第一行的内容\n\t第二行的内容   还有\t更多多空格结尾  </p></main>`))
    expect(blocks[0]!.text).toBe('第一行的内容 第二行的内容 还有 更多多空格结尾')
  })

  it('textHash 是归一化文本的 sha256；同文本跨页同 hash 由 project 层验证', () => {
    const blocks = extractBlocks(htmlOf(`<main><p>${LONG}</p></main>`))
    expect(blocks[0]!.textHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(blocks[0]!.textHash.endsWith(createHash('sha256').update(LONG, 'utf8').digest('hex'))).toBe(true)
  })

  it('空 HTML / 空 body → 空数组', () => {
    expect(extractBlocks('')).toEqual([])
    expect(extractBlocks('<html><head></head><body></body></html>')).toEqual([])
    expect(extractBlocks('<html><body><main><p>太短</p></main></body></html>')).toEqual([])
  })
})
