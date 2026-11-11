package difftools

import (
	"strconv"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

type hlLine struct {
	line DiffLine
	hl   string
}

func at(list []string, i int, fallback string) string {
	if i < len(list) {
		return list[i]
	}
	return fallback
}

func jsTrimEndString(s string) string { return jsstr.TrimEnd(s) }

// RenderUnified ports hunk-preview.ts renderUnified.
func (p *Palette) RenderUnified(diff ParsedDiff, language string, maxLines int, colors DiffColors, width int, o RenderOptions) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.renderUnified(diff, language, maxLines, colors, width, o)
}

func (p *Palette) renderUnified(diff ParsedDiff, language string, maxLines int, colors DiffColors, width int, o RenderOptions) string {
	s := p.hp
	if len(diff.Lines) == 0 {
		return ""
	}
	visible := diff.Lines[:min(max(maxLines, 0), len(diff.Lines))]
	renderWidth := max(minRenderWidth, width)
	nw := numberWidth(visible)
	gutterWidth := nw + 4
	if o.CompactGutter {
		gutterWidth--
	}
	codeWidth := max(20, renderWidth-gutterWidth)
	canHL := diff.Chars <= maxHLChars && len(visible) <= maxLines
	var oldSrc, newSrc []string
	for _, l := range visible {
		if l.Type == "ctx" || l.Type == "del" {
			oldSrc = append(oldSrc, l.Content)
		}
		if l.Type == "ctx" || l.Type == "add" {
			newSrc = append(newSrc, l.Content)
		}
	}
	oldHL, newHL := oldSrc, newSrc
	if canHL {
		oldHL, newHL = p.hlBlock(strings.Join(oldSrc, "\n"), language), p.hlBlock(strings.Join(newSrc, "\n"), language)
	}
	var out []string
	emit := func(num *int, sign, gutterBg, signFg, body, bodyBg string) {
		borderFg := ""
		switch sign {
		case "-":
			borderFg = colors.FgDel
		case "+":
			borderFg = colors.FgAdd
		}
		border := ""
		if !o.CompactGutter {
			if borderFg != "" {
				border = borderFg + p.borderBar() + s.rst
			} else {
				border = s.bgBase + " "
			}
		}
		numFg := borderFg
		if numFg == "" {
			numFg = s.fgLnum
		}
		gutter := border + gutterBg + s.lnum(num, nw, numFg) + gutterBg + " " + signFg + sign + gutterBg + " " + s.rst
		cont := border + gutterBg + strings.Repeat(" ", nw+3) + s.rst
		rows := s.wrapAnsi(tabs(body), codeWidth, adaptiveWrapRows(renderWidth), bodyBg)
		out = append(out, gutter+rows[0]+s.rst)
		for _, r := range rows[1:] {
			out = append(out, cont+r+s.rst)
		}
	}
	oI, nI := 0, 0
	for idx := 0; idx < len(visible); {
		l := visible[idx]
		if l.Type == "sep" {
			label := SepLabelUnified(p.SepStyle, l.HunkMeta, l.NewNum, l.Content)
			if label == "" {
				idx++
				continue
			}
			total := min(renderWidth, 72)
			pad := max(0, total-jsstr.Len16(label)-2)
			left := pad / 2
			out = append(out, s.bgBase+s.fgDim+strings.Repeat("─", left)+label+strings.Repeat("─", pad-left)+s.rst)
			idx++
			continue
		}
		if l.Type == "ctx" {
			emit(l.NewNum, " ", s.bgBase, colors.FgCtx, s.bgBase+dim+at(oldHL, oI, l.Content), s.bgBase)
			oI++
			nI++
			idx++
			continue
		}
		var dels, adds []hlLine
		for idx < len(visible) && visible[idx].Type == "del" {
			dels = append(dels, hlLine{visible[idx], at(oldHL, oI, visible[idx].Content)})
			oI++
			idx++
		}
		for idx < len(visible) && visible[idx].Type == "add" {
			adds = append(adds, hlLine{visible[idx], at(newHL, nI, visible[idx].Content)})
			nI++
			idx++
		}
		paired := len(dels) == 1 && len(adds) == 1
		var wd wordDiffResult
		balanced := false
		if paired {
			wd = wordDiffAnalysis(dels[0].line.Content, adds[0].line.Content)
			balanced = len(wd.oldRanges) > 0 && len(wd.newRang) > 0
		}
		if paired && balanced && wd.similarity >= wordDiffMinSim {
			if canHL {
				emit(dels[0].line.OldNum, "-", s.bgGutterDel, colors.FgDel, s.injectBg(dels[0].hl, wd.oldRanges, s.bgDel, s.bgDelW), s.bgDel)
				emit(adds[0].line.NewNum, "+", s.bgGutterAdd, colors.FgAdd, s.injectBg(adds[0].hl, wd.newRang, s.bgAdd, s.bgAddW), s.bgAdd)
			} else {
				o, n := s.plainWordDiff(dels[0].line.Content, adds[0].line.Content)
				emit(dels[0].line.OldNum, "-", s.bgGutterDel, colors.FgDel, s.bgDel+o, s.bgDel)
				emit(adds[0].line.NewNum, "+", s.bgGutterAdd, colors.FgAdd, s.bgAdd+n, s.bgAdd)
			}
			continue
		}
		for _, d := range dels {
			body := s.bgDel + d.line.Content
			if canHL {
				body = s.injectBg(d.hl, nil, s.bgDel, s.bgDel)
			}
			emit(d.line.OldNum, "-", s.bgGutterDel, colors.FgDel, body, s.bgDel)
		}
		for _, a := range adds {
			body := s.bgAdd + a.line.Content
			if canHL {
				body = s.injectBg(a.hl, nil, s.bgAdd, s.bgAdd)
			}
			emit(a.line.NewNum, "+", s.bgGutterAdd, colors.FgAdd, body, s.bgAdd)
		}
	}
	if len(diff.Lines) > len(visible) {
		out = append(out, s.bgBase+s.fgDim+"  … "+strconv.Itoa(len(diff.Lines)-len(visible))+" more lines"+s.rst)
	}
	return strings.Join(out, "\n")
}

type splitRow struct{ left, right *DiffLine }

type halfResult struct {
	gutter, cont string
	bodyRows     []string
}

// RenderSplit ports hunk-preview.ts renderSplit (unified when split does not fit).
func (p *Palette) RenderSplit(diff ParsedDiff, language string, maxLines int, colors DiffColors, width int, o RenderOptions) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.renderSplit(diff, language, maxLines, colors, width, o)
}

func (p *Palette) renderSplit(diff ParsedDiff, language string, maxLines int, colors DiffColors, width int, o RenderOptions) string {
	if !p.shouldUseSplit(diff, width, maxLines, o) {
		return p.renderUnified(diff, language, maxLines, colors, width, o)
	}
	s := p.hp
	var rows []splitRow
	lines := diff.Lines
	for idx := 0; idx < len(lines); {
		l := &lines[idx]
		if l.Type == "ctx" || l.Type == "sep" {
			rows = append(rows, splitRow{l, l})
			idx++
			continue
		}
		var dels, adds []*DiffLine
		for idx < len(lines) && lines[idx].Type == "del" {
			dels = append(dels, &lines[idx])
			idx++
		}
		for idx < len(lines) && lines[idx].Type == "add" {
			adds = append(adds, &lines[idx])
			idx++
		}
		for r := 0; r < max(len(dels), len(adds)); r++ {
			var row splitRow
			if r < len(dels) {
				row.left = dels[r]
			}
			if r < len(adds) {
				row.right = adds[r]
			}
			rows = append(rows, row)
		}
	}
	visible := rows[:min(max(maxLines, 0), len(rows))]
	renderWidth := max(minRenderWidth, width)
	nw := numberWidth(diff.Lines)
	gutterWidth := nw + 4
	if o.CompactGutter {
		gutterWidth--
	}
	half := renderWidth / 2
	codeWidth := max(12, half-gutterWidth)
	canHL := diff.Chars <= maxHLChars && len(visible)*2 <= maxLines*2
	var leftSrc, rightSrc []string
	for _, r := range visible {
		if r.left != nil && r.left.Type != "sep" {
			leftSrc = append(leftSrc, r.left.Content)
		}
		if r.right != nil && r.right.Type != "sep" {
			rightSrc = append(rightSrc, r.right.Content)
		}
	}
	leftHL, rightHL := leftSrc, rightSrc
	if canHL {
		leftHL, rightHL = p.hlBlock(strings.Join(leftSrc, "\n"), language), p.hlBlock(strings.Join(rightSrc, "\n"), language)
	}
	build := func(line *DiffLine, hl string, ranges [][2]int, left bool) halfResult {
		if line == nil {
			return halfResult{bodyRows: []string{""}}
		}
		if line.Type == "sep" {
			label := SepLabelSplit(p.SepStyle, line.HunkMeta, line.NewNum, line.Content)
			if label == "" {
				return halfResult{bodyRows: []string{""}}
			}
			g := s.bgBase + s.fgDim + s.fit("", nw+3) + s.rst
			if !o.CompactGutter {
				g = s.bgBase + " " + s.fgDim + s.fit("", nw+3) + s.rst
			}
			return halfResult{gutter: g, cont: g, bodyRows: []string{s.bgBase + s.fgDim + s.fit(label, codeWidth) + s.rst}}
		}
		isDel, isAdd := line.Type == "del", line.Type == "add"
		gutterBg, codeBg, signFg, sign := s.bgBase, s.bgBase, colors.FgCtx, " "
		num, borderFg := line.NewNum, ""
		if left {
			num = line.OldNum
		}
		switch {
		case isDel:
			gutterBg, codeBg, signFg, sign, num, borderFg = s.bgGutterDel, s.bgDel, colors.FgDel, "-", line.OldNum, colors.FgDel
		case isAdd:
			gutterBg, codeBg, signFg, sign, num, borderFg = s.bgGutterAdd, s.bgAdd, colors.FgAdd, "+", line.NewNum, colors.FgAdd
		}
		border := ""
		if !o.CompactGutter {
			if borderFg != "" {
				border = borderFg + p.borderBar() + s.rst
			} else {
				border = s.bgBase + " "
			}
		}
		numFg := borderFg
		if numFg == "" {
			numFg = s.fgLnum
		}
		body := s.bgBase + dim + hl
		if isDel || isAdd {
			body = s.injectBg(hl, nil, codeBg, codeBg)
		}
		if len(ranges) > 0 {
			hlBg := s.bgAddW
			if isDel {
				hlBg = s.bgDelW
			}
			body = s.injectBg(hl, ranges, codeBg, hlBg)
		}
		return halfResult{
			gutter:   border + gutterBg + s.lnum(num, nw, numFg) + gutterBg + " " + signFg + sign + gutterBg + " " + s.rst,
			cont:     border + gutterBg + strings.Repeat(" ", nw+3) + s.rst,
			bodyRows: s.wrapAnsi(tabs(body), codeWidth, adaptiveWrapRows(renderWidth), codeBg),
		}
	}
	var out []string
	lI, rI := 0, 0
	for _, row := range visible {
		paired := row.left != nil && row.right != nil && row.left.Type == "del" && row.right.Type == "add"
		var wd wordDiffResult
		balanced := false
		if paired {
			wd = wordDiffAnalysis(row.left.Content, row.right.Content)
			balanced = len(wd.oldRanges) > 0 && len(wd.newRang) > 0
		}
		leftHl, rightHl := "", ""
		if row.left != nil && row.left.Type != "sep" {
			leftHl = at(leftHL, lI, row.left.Content)
			lI++
		}
		if row.right != nil && row.right.Type != "sep" {
			rightHl = at(rightHL, rI, row.right.Content)
			rI++
		}
		var lr, rr [][2]int
		if paired && balanced && wd.similarity >= wordDiffMinSim {
			lr, rr = wd.oldRanges, wd.newRang
		}
		lh, rh := build(row.left, leftHl, lr, true), build(row.right, rightHl, rr, false)
		for k := 0; k < max(len(lh.bodyRows), len(rh.bodyRows)); k++ {
			lb, rb := at(lh.bodyRows, k, ""), at(rh.bodyRows, k, "")
			if lh.gutter == "" && rh.gutter == "" && lb == "" && rb == "" {
				continue
			}
			lg, rg := lh.cont, rh.cont
			if k == 0 {
				lg, rg = lh.gutter, rh.gutter
			}
			out = append(out, lg+jsTrimEndString(lb)+rg+jsTrimEndString(rb))
		}
	}
	if len(rows) > len(visible) {
		out = append(out, s.bgBase+s.fgDim+"  … "+strconv.Itoa(len(rows)-len(visible))+" more lines"+s.rst)
	}
	return strings.Join(out, "\n")
}

// RenderReviewHunkPreview ports renderReviewHunkPreview.
func (p *Palette) RenderReviewHunkPreview(h ReviewHunk, filePath string, t Theme, width, maxLines int) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	diff := ParsedDiff{Lines: []DiffLine{}}
	for _, l := range h.Lines {
		diff.Chars += jsstr.Len16(l.Content)
		switch l.Type {
		case "add":
			diff.Added++
		case "del":
			diff.Removed++
		}
		diff.Lines = append(diff.Lines, DiffLine{Type: l.Type, OldNum: l.OldNum, NewNum: l.NewNum, Content: l.Content})
	}
	if width == 0 {
		width = defaultRenderW
	}
	if maxLines <= 0 {
		maxLines = len(diff.Lines)
	}
	if !p.paletteApplied {
		// ensurePalette: hunk-preview.ts applies the palette once more here.
		p.hp.applyDiffPalette(p.cfg, p.env)
		p.paletteApplied = true
	}
	colors := p.hp.resolve(t)
	return p.renderUnified(diff, Lang(filePath), maxLines, colors, max(minRenderWidth, width), RenderOptions{})
}
