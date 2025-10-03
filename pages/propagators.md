---
title: Propagators
contributors: Mariano Guerra
---

## Abstract

We develop a programming model built on the idea that the basic computational elements are autonomous machines interconnected by shared cells through which they communicate.

Each machine continuously examines the cells it is interested in, and adds information to some based on deductions it can make from information from the others.

This model makes it easy to smoothly combine expression-oriented and constraint-based programming; it also easily accommodates implicit incremental distributed search in ordinary programs.

## Papers

- [The Art of the Propagator - Alexey Radul & Gerald Jay Sussman](https://citeseerx.ist.psu.edu/document?doi=755c48fd10aa303497ef849977c36529c0bb09ff&repid=rep1&type=pdf)
- [Propagation Networks: A Flexible and Expressive Substrate for Computation by Alexey Andreyevich Radul](https://www.cs.tufts.edu/~nr/cs257/archive/alexey-radul/phd-thesis.pdf)

## Presentations

- [Gerald Jay Sussman The Art of the Propagator](https://www.youtube.com/watch?v=-hQFrKspQHA)
- [George Wilson - An Intuition for Propagators - Compose Melbourne 2019](https://www.youtube.com/watch?v=nY1BCv3xn24)
- [Propagators Part 1 • Edward Kmett • YOW! 2016](https://www.youtube.com/watch?v=tETbivwzXBM)
- [Propagators Part 2 • Edward Kmett • YOW! 2016](https://www.youtube.com/watch?v=0igYOKcIWUs)
- [Thomas Kristensen - Propagators in Clojure](https://www.youtube.com/watch?v=JXOOO9MLvhs)

## Projects

- [Propaganda: A propagator library for Clojure](https://github.com/tgk/propaganda)
- [Propagators: A propagator library for Haskell](https://github.com/ekmett/propagators)
- [Holograph: Visual propagators on top of tldraw](https://www.holograph.so/)

## Related Work

- [Scoped Propagators](https://www.orionreed.com/posts/scoped-propagators) - [HN Discussion](https://news.ycombinator.com/item?id=40916193)
