###

this file is a work in progress and a bit messy/undetermined. good luck! :)
if you have any questions, feel free to ask Ivan. he loves talking about coffee script!

###






###
Feeling of Computing Wiki
CoffeeScript Build Script

This is the reference implementation for the build script.
It is run automatically on every commit to the repo.

If you'd like to run it locally:
1. Install coffeescript via npm: `npm i -g coffeescript`
2. From the root of the repo, run `coffee build/build.coffee`
3. If you also want to view the wiki locally, from the root of repo, run `npx http-server`

If you don't use npm, or don't want to install CoffeeScript,
you should use any of the other build scripts in this folder.
They all do the same thing.

You are heartily encouraged to port this script to your language of choice,
and add it to the `build` folder. Bonus points for using a language you made yourself :)
Requirements:
* Your script must be a single file, or placed in its own subfolder. Keep the main `build` folder tidy.
* You must include instructions for how to run your script.
* Please use as few dependencies as possible.

Also:
* I only tested this script on Mac. If you can make some small changes to get it to run on Windows, please do!
* I also wrote a JavaScript version of the script, so feel free to reference that one as well.
###

# DEPENDENCIES

# This script uses the `fs` module from NodeJS to read and write files
fs = require "fs"

# HELPER FUNCTIONS

# If any folders in the given path don't exist, create them
mkdir = (path)-> fs.mkdirSync path, recursive: true

# Given a file path, make sure all parent directories exist, then return the path
ensureDir = (path)-> mkdir(path.split("/")[0...-1].join("/")); path

# Delete the file or folder at the given path, or fail silently if it doesn't exist
rm = (path)-> try fs.rmSync path, recursive: true

# Give us the names of all the files in a given folder, ignoring dotfiles
readDir = (path)-> fs.readdirSync(path).filter (file)-> !file.startsWith "."

# Return the text contents of the file at the given path
readFile = (path)-> fs.readFileSync(path).toString()

# Make a file at the given path, containing the given text
writeFile = (path, text)-> fs.writeFileSync ensureDir(path), text

# Copy the file from the given path to the given destination path
copyFile = (path, dest)-> fs.copyFileSync path, dest

# Given an html tag name, return a function that wraps a given string in that tag
tag = (t)-> (str)-> "<#{t}>#{str}</#{t}>"

# A function that wraps a string in an <li> tag
li = tag "li"

# Replace certain characters with HTML entities. Useful for code blocks.
entityEncode = (str)->
  str
    .replaceAll "&", "&amp;"
    .replaceAll "<", "&lt;"
    .replaceAll ">", "&gt;"


# This whitespace makes our HTML look nicer
indent = "      "

# These Tonedown rewrite rules help us figure out which HTML element(s) to use for the following line(s) of input
lineRules =
  " "   : "skip"
  "### ": "h3"
  "## " : "h2"
  "# "  : "h1"
  "<"   : "html"
  "> "  : "blockquote"
  "* "  : "li"
  "- "  : "li"
  "```" : "code"
  ""    : "p"

# For a given line of input, figure out which Tonedown rule applies
getRule = (line)->
  for mark, rule of lineRules
    if line.startsWith mark
      return [mark, rule]

# Process the given lines of input
processLines = (page, lines)->

  # The parser can be in one of three modes — "normal", "code", or "list"
  mode = "normal"

  # Build up the HTML output in this string
  body = ""

  # Process each line one by one
  for line in lines

    # Extract the Tonedown mark from the start of the line, and get the corresponding rule to apply
    [mark, rule] = getRule line

    # Check for code mode boundary
    # TODO: Add support for a language directive after the mark (for syntax highlighting)
    if rule is "code"

      # When we encounter a code rule, toggle in/out of code mode
      mode = if mode is "code" then "normal" else "code"

      if mode is "code"
        # Begin the code block
        body += "<pre><code>"
      else
        # Remove the \n from the previous line
        body = body.slice 0, -1
        # End the code block
        body += "</code></pre>\n"
      continue

    # When in code mode, encode a few chars, but otherwise leave the line as-is
    if mode is "code"
      body += entityEncode line + "\n"
      continue

    # Check for list mode boundary
    if rule is "li" and mode isnt "list"
      mode = "list"
      body += indent + "<ul>" + "\n"
    else if mode is "list" and rule isnt "li"
      mode = "normal"
      body += indent + "</ul>" + "\n"

    # Pass HTML straight through
    if rule is "html"
      body += indent + line + "\n"
      continue

    # Remove the mark and outer whitespace from the line
    line = line.replace(mark, "").trim()

    # This is a weird trick for not generating a <p> tag — just indent it by one or more spaces
    if rule is "skip"
      body += line + "\n"
      continue

    # If the line is now empty, bail
    continue if line.length is 0

    # Now process all the inline rules
    line = processInline page, line

    # Build our tags
    open = "<" + rule + ">"
    close = "</" + rule + ">"

    # Some tags get extra indentation, for pretty html output
    open = "  " + open if mode is "list"

    # Wrap the line in the tags
    body += [indent, open, line, close].join("") + "\n"

  # Put all the processed lines together into a body
  return body

# Processing within a line
processInline = (page, line)->
  chars = Array.from line # Don't use .split("") because that doesn't handle multi-part unicode
  out = ""

  mode = {}
  toggle = (m)->
    mode[m] = if mode[m] then false else true
    out += if mode[m] then "<#{m}>" else "</#{m}>"

  doubles = "[*_" # these chars can appear in a double
  checkForDouble = (c)->
    return c if doubles.indexOf(c) is -1 # we only check certain chars for a double
    # we might have a double
    next = chars.shift() # pull the next char
    return c + c if c is next # if they match, we have a double!
    # no double
    chars.unshift next # put the next char back in place
    return c # we don't have a double

  consumeUntil = (p)->
    res = "" # build up this string until it ends with p
    while chars.length > 0
      res += chars.shift()
      if res.endsWith(p) # when res ends with p
        return res.slice 0, -p.length # strip p from the end, and return res
    # we didn't find a match for p, so restore chars and return null
    chars = Array.from(res).concat chars
    null

  while chars.length > 0

    # pull the next char
    char = chars.shift()

    # If the following char is one of our valid doubles, pull it too
    char = checkForDouble char

    if char is "[[" # Internal link
      str = consumeUntil "]]"
      [text, title] = str.split "|"
      title ||= text
      title.trim()
      text.trim()
      if dest = pages[title]
        dest.backlinks[page.data.title] = page.url
        out += "<a href=\"#{dest.url}\">#{text}</a>"

    # else if char is "<" # Inline HTML !!
    #   str = consumeUntil ">"
    #   out += "<#{str}>"

    else if char is "["
      if str = consumeUntil ")"
        [text, url] = str.split "]("
        url = "https://#{url}" unless url.toLowerCase().startsWith "http"
        out += "<a href=\"#{url}\">#{text}</a>"
      else
        out += "["

    else if char is "`"
      str = consumeUntil "`"
      out += "<code>#{entityEncode str}</code>"

    else if char is "**" or char is "__"
      toggle "strong"

    else if char is "*" or char is "_"
      toggle "em"

    else
      out += char

  out

# Begin processing all files

# First, clear the `public` folder by deleting and remaking it
rm "public"
mkdir "public"

# Copy all static assets to the `public` folder
for file in readDir "assets"
  copyFile "assets/#{file}", "public/#{file}"

# Load the page layout HTML template
layout = readFile "build/layout.html"

# We have to do two passes over all the pages
# The first pass, we put together all the internal links (so we can fill out backlinks)
# The second pass, we compile all the pages

# Build up metadata about each page
pages = {}

# Loop through page files
for pageFilename in readDir "pages"

  # Make a page to store the page metadata
  page = {
    content: "Nothing here..."
    sourcePath: "unknown-path"
    destPath: "unknown-path"
    url: "unknown-url"
    backlinks: {}
    html: "Unknown HTML"
  }

  # Source path
  page.sourcePath = "pages/" + pageFilename

  # Separate the name of the page file from the extension
  [pageName, _] = pageFilename.split "."

  # This is the full destination path where we'll save our page.
  # To make the URLs pretty, each page becomes an "index.html" file in its own folder.
  if pageName is "404"
    page.destPath = "public/404.html"
  else
    page.destPath = "public/" + pageName + "/index.html"

  # One exception to the above — the main index of the site does not go in its own folder.
  page.destPath = page.destPath.replace "/index/index.html", "/index.html"

  page.url = if pageName is "index" then "/" else "/#{pageName}"

  # Load this page file's content
  page.content = readFile page.sourcePath

  # Process the frontmatter
  [a, frontmatter, ...body] = page.content.split "---"

  body = body.join "---"

  # Save the body
  page.body = body

  # If we don't have frontmatter, skip the page
  if not frontmatter
    console.log "page `#{pageFilename}` is missing frontmatter"
    continue

  # Extract key-value pairs from the frontmatter
  page.data = {}
  for line in frontmatter.split "\n"
    [k, v] = line.split /\s*:\s*/
    page.data[k] = v

  # Save the page by title
  pages[page.data.title] = page


# BUILD THE PAGE BODY
for pageName, page of pages

  # If this page is markdown, run it through our list of replacement rules
  page.html = processLines page, page.body.split "\n"

  # Inject the page title as a visible title element
  page.html = "\n#{indent}<title>#{page.data.title}</title>\n" + page.html


# DRAW THE REST OF THE OWL
for pageName, page of pages
  html = layout

  # Replace the string {{path}} with the path to this page file — used for Edit on GitHub link
  html = html.replaceAll "{{path}}", page.sourcePath

  aside = ""
  backlinks = ("<a href=\"#{url}\">#{title}</a>" for title, url of page.backlinks)

  if page.data.contributors? or backlinks.length

    aside = "<aside>\n"

    if page.data.contributors?
      lis = page.data.contributors.split(",").map((c)-> li c.trim()).join ""
      aside += indent + "  <section><h1>Contributors</h1><ul>#{lis}</ul></section>\n"

    if backlinks.length
      lis = backlinks.map(li).join("")
      aside += indent + "  <section><h1>Backlinks</h1><ul>#{lis}</ul></section>\n"

    aside += indent + "</aside>"

  html = html.replaceAll "{{aside}}", aside

  # Replace the string {{page}} with the page body
  html = html.replace /\s*{{page}}/, page.html

  # Replace the string {{all}} with links to all pages
  html = html.replaceAll "{{all}}", (li "<a href=\"#{p.url}\">#{p.data.title}</a>" for _, p of pages when p.data.title not in ["404", "All Pages", "Search", "Feeling of Computing Wiki"]).join "\n"

  # Finally, write the page content to the destination path.
  writeFile page.destPath, html
