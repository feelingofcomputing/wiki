---
title: Tonedown
contributors: Ivy Reese
---

Tonedown is a plain text markup language. You'll find it pleasant to read and write Tonedown, especially long-form prose like a wiki entry. The syntax should get out of your way and let you focus on the content of your writing.

It borrows most of its syntax from [Markdown](https://daringfireball.net/projects/markdown/), and you should use the `.md` file extension so that your text editor will give you nice syntax highlighting.

It borrows from the philosophy of [Gemtext](https://gemini.flounder.online/docs/cheatsheet.gmi) that it should be easy to process with a small implementation.

# A Brief but Tiresome Tour of Tonedown

## Paragraphs
Each line of plain writing becomes its own paragraph.

```
It is late. The window is open.
A machine drones in the distance.

It can't even hold a steady pitch.
```
↓
```
<p>It is late. The window is open.</p>
<p>A machine drones in the distance.</p>
<p>It can't even hold a steady pitch.</p>
```

* Blank lines are ignored.
* It's recommended that you enable **Soft Wrap** in your editor.

## Headings
Tonedown supports three levels of heading, colloquially named as follows.

```
# Major heading
## Minor heading
### Diminished heading
```
↓
```
<h1>Major heading</h1>
<h2>Minor heading</h2>
<h3>Diminished heading</h3>
```

## Lists
Any line beginning with a `-` or a `*` will make a list.

```
- Do Make
- Say Think
```
↓
```
<ul>
  <li>Do Make</li>
  <li>Say Think</li>
</ul>
```

## Code
Use a backtick <code>&grave;</code> to indicate code.

```
Does `5 x 3` count as code?
```
↓
```
Does <code>5 x 3</code> count as code?
```

<br>

You can also use three backticks to make a whole block of code.

<pre><code>&grave;&grave;&grave;
  Vibes.tighten()
  &grave;&grave;&grave;</code></pre>
↓
```
<pre><code>Vibes.tighten()</code></pre>
```

## Quotes
Prepend each line with `>` to indicate a block quote.

```
> The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
> "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in
> this document are to be interpreted as described in RFC 2119.
```
↓
> The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
> "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in
> this document are to be interpreted as described in RFC 2119.

## Formatting

Surround a word with:
* `*` or `_` for `<em>`, which is rendered as *italic*, or
* `**` or `__` for `<strong>`, rendered as **bold**.

```
Tonedown is *demure*, like **dirt under my pillow**.
```
↓
```
Tonedown is <em>demure</em>, like <strong>dirt under my pillow</strong>.
```

## Links

Tonedown supports two kinds of link.

Use an **internal link** to link to another wiki page.

```
Be sure to check out the [[Tonedown]] documentation,
and the [[contributing guide|Contributing]]
```
↓
```
Be sure to check out the <a href="/tonedown">Tonedown</a> documentation,
and the <a href="/contributing">contributing guide</a>
```

<br>

Use an **external link** to link to another website.

```
The [Feeling of Computing](feelingof.com) community.
```
↓
```
The <a href="https://feelingof.com">Feeling of Computing</a> community.
```

## HTML

You can use HTML anywhere.

```
I've got <span style="font-family: fantasy">weird</span> feelings.

<small>But I'm a good friend.</small>
```
↓
I've got <span style="font-family: fantasy">weird</span> feelings.

<small>But I'm a good friend.</small>
