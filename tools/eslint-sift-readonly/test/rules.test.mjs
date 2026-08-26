import { describe, expect, it } from 'vitest'
import { Linter } from 'eslint'
import { siftReadonlyRules } from '../index.js'

const linter = new Linter({ configType: 'flat' })
const config = [
  { files: ['**/*.js'], rules: siftReadonlyRules, languageOptions: { ecmaVersion: 2022, sourceType: 'module' } },
]

const countErrors = (code) => linter.verify(code, config, 'case.js').filter((m) => m.severity === 2).length

describe('sift-readonly 第一层：全局副作用一律禁止', () => {
  const banned = [
    ["eval('1')", 'eval'],
    ["const f = new Function('return 1')", 'new Function'],
    ["fetch('https://evil.example/')", '全局 fetch'],
    ["window.fetch('https://evil.example/')", '成员 fetch'],
    ["const x = new XMLHttpRequest()", 'XHR'],
    ["const ws = new WebSocket('wss://x')", 'WebSocket'],
    ["const es = new EventSource('/s')", 'EventSource'],
    ['window.open("https://x")', 'window.open'],
    ["open('https://x')", '裸 open'],
    ["window.postMessage({a:1}, '*')", 'postMessage'],
    ["navigator.sendBeacon('https://x', {})", 'sendBeacon'],
    ["document.write('<b>x</b>')", 'document.write（1 层链）'],
  ]
  for (const [code, label] of banned) {
    it(`禁止：${label}`, () => {
      expect(countErrors(code)).toBeGreaterThan(0)
    })
  }
})

describe('sift-readonly 第二层：document 根链写禁止', () => {
  const banned = [
    ['document.body.appendChild(n)', '2 层 appendChild'],
    ['document.head.appendChild(s)', '2 层 head'],
    ['document.documentElement.removeChild(n)', '2 层 documentElement'],
    ['document.body.setAttribute("data-x","1")', '2 层 setAttribute'],
    ['document.body.firstElementChild.appendChild(n)', '3 层'],
    ['document.body.firstChild.nextSibling.setAttribute("a","b")', '4 层'],
    ["el.innerHTML = '<b>x</b>'", 'innerHTML 赋值（任意接收者）'],
    ["document.title = 'x'", 'document 链赋值'],
    ["location.href = 'https://x'", 'location.href 赋值'],
    ["location.assign('https://x')", 'location.assign'],
    ["history.pushState({}, '', '/x')", 'history.pushState'],
    ['el.focus()', 'focus（任意接收者）'],
    ['el.click()', 'click'],
    ['el.scrollIntoView()', 'scrollIntoView'],
    ['window.print()', 'window.print'],
  ]
  for (const [code, label] of banned) {
    it(`禁止：${label}`, () => {
      expect(countErrors(code)).toBeGreaterThan(0)
    })
  }
})

describe('sift-readonly 合法路径：clone 子树与只读访问', () => {
  const allowed = [
    ['const c = document.body.cloneNode(true)', 'cloneNode'],
    ['const frag = document.createDocumentFragment()', 'createDocumentFragment'],
    ['const t = document.createTextNode("x")', 'createTextNode'],
    ['const c = document.body.cloneNode(true); c.removeChild(c.firstChild)', 'clone 上 removeChild'],
    ['const c = document.importNode(n, true)', 'importNode'],
    ['c.setAttribute("data-sift", "1")', 'clone 上 setAttribute'],
    ['c.removeAttribute("onclick")', 'clone 上 removeAttribute'],
    ['n.parentElement?.remove()', '非 document 接收者 remove'],
    ["const t = document.querySelector('h1')?.textContent", 'querySelector 读取'],
    ["const id = document.getElementById('x')", 'getElementById 读取'],
    ["const title = document.title", 'document.title 读取'],
    ['const u = location.href', 'location.href 读取'],
    ['const html = c.outerHTML', 'outerHTML 读取'],
    ['c.textContent = ""', 'clone 上 textContent 赋值'],
    ['observer.observe(document.body, { childList: true })', 'observe 挂载'],
  ]
  for (const [code, label] of allowed) {
    it(`允许：${label}`, () => {
      expect(countErrors(code)).toBe(0)
    })
  }
})
