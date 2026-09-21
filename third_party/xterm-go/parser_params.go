package xterm

// Ported from xterm.js src/common/parser/Params.ts.
//
// Params accumulates sequence parameters and sub-parameters during parsing
// and passes them to input handler actions. The object is borrowed by handlers;
// use Clone or ToArray to retain values beyond the handler call.

// maxParamValue is the maximum value for a single param/sub-param (positive int32 range).
const maxParamValue int32 = 0x7FFFFFFF

// maxSubParams is the hard limit on total sub-parameters per sequence.
const maxSubParams = 256

// Params stores CSI/DCS sequence parameters and their sub-parameters.
type Params struct {
	// Params is the main parameter array. Only indices [0, Length) are valid.
	Params    []int32
	Length    int
	MaxLength int

	subParams       []int32
	subParamsLength int
	maxSubParamsLen int

	// subParamsIdx encodes [start, end) offsets for sub-params of each param.
	// Upper 16 bits = start, lower 16 bits = end.
	subParamsIdx []uint32

	rejectDigits    bool
	rejectSubDigits bool
	digitIsSub      bool
}

// NewParams creates a Params with the given capacity limits.
func NewParams(maxLength, maxSubParamsLength int) *Params {
	if maxSubParamsLength > maxSubParams {
		panic("maxSubParamsLength must not be greater than 256")
	}
	return &Params{
		Params:          make([]int32, maxLength),
		MaxLength:       maxLength,
		subParams:       make([]int32, maxSubParamsLength),
		maxSubParamsLen: maxSubParamsLength,
		subParamsIdx:    make([]uint32, maxLength),
	}
}

// DefaultParams creates a Params with default limits (32 params, 32 sub-params).
func DefaultParams() *Params {
	return NewParams(32, 32)
}

// Reset clears all parameters to the initial empty state.
func (p *Params) Reset() {
	p.Length = 0
	p.subParamsLength = 0
	p.rejectDigits = false
	p.rejectSubDigits = false
	p.digitIsSub = false
}

// ResetZdm resets the params and seeds a single zero-default param (ZDM).
// Equivalent to Reset() followed by AddParam(0); kept as a single call to
// mirror the upstream xterm.js Params.resetZdm helper.
func (p *Params) ResetZdm() {
	p.Reset()
	p.AddParam(0)
}

// AddParam appends a parameter value. Values < -1 panic. Values beyond
// maxLength are silently ignored. Values exceeding maxParamValue are clamped.
func (p *Params) AddParam(value int32) {
	p.digitIsSub = false
	if p.Length >= p.MaxLength {
		p.rejectDigits = true
		return
	}
	if value < -1 {
		panic("values lesser than -1 are not allowed")
	}
	if value > maxParamValue {
		value = maxParamValue
	}
	p.subParamsIdx[p.Length] = uint32(p.subParamsLength)<<8 | uint32(p.subParamsLength)
	p.Params[p.Length] = value
	p.Length++
}

// AddSubParam appends a sub-parameter associated with the last parameter.
// Ignored if no parameter has been added yet or limits are exceeded.
func (p *Params) AddSubParam(value int32) {
	p.digitIsSub = true
	if p.Length == 0 {
		return
	}
	if p.rejectDigits || p.subParamsLength >= p.maxSubParamsLen {
		p.rejectSubDigits = true
		return
	}
	if value < -1 {
		panic("values lesser than -1 are not allowed")
	}
	if value > maxParamValue {
		value = maxParamValue
	}
	p.subParams[p.subParamsLength] = value
	p.subParamsLength++
	p.subParamsIdx[p.Length-1]++
}

// HasSubParams returns whether the parameter at idx has sub-parameters.
func (p *Params) HasSubParams(idx int) bool {
	end := p.subParamsIdx[idx] & 0xFF
	start := p.subParamsIdx[idx] >> 8
	return end-start > 0
}

// GetSubParams returns the sub-parameters for the parameter at idx.
// Returns nil if there are no sub-parameters. The returned slice is borrowed.
func (p *Params) GetSubParams(idx int) []int32 {
	start := int(p.subParamsIdx[idx] >> 8)
	end := int(p.subParamsIdx[idx] & 0xFF)
	if end-start > 0 {
		return p.subParams[start:end]
	}
	return nil
}

// GetSubParamsAll returns a map of param index to cloned sub-parameter slices.
func (p *Params) GetSubParamsAll() map[int][]int32 {
	result := make(map[int][]int32)
	for i := range p.Length {
		start := int(p.subParamsIdx[i] >> 8)
		end := int(p.subParamsIdx[i] & 0xFF)
		if end-start > 0 {
			sub := make([]int32, end-start)
			copy(sub, p.subParams[start:end])
			result[i] = sub
		}
	}
	return result
}

// AddDigit adds a single digit to the current parameter or sub-parameter.
// Used by the parser to accumulate digits character by character.
func (p *Params) AddDigit(value int32) {
	if p.rejectDigits {
		return
	}
	var length int
	if p.digitIsSub {
		length = p.subParamsLength
	} else {
		length = p.Length
	}
	if length == 0 {
		return
	}
	if p.digitIsSub && p.rejectSubDigits {
		return
	}

	var store []int32
	if p.digitIsSub {
		store = p.subParams
	} else {
		store = p.Params
	}
	cur := store[length-1]
	if cur == -1 {
		store[length-1] = value
	} else {
		v := cur*10 + value
		if v > maxParamValue {
			v = maxParamValue
		}
		store[length-1] = v
	}
}

// Clone returns a deep copy of the Params.
func (p *Params) Clone() *Params {
	np := NewParams(p.MaxLength, p.maxSubParamsLen)
	copy(np.Params, p.Params)
	np.Length = p.Length
	copy(np.subParams, p.subParams)
	np.subParamsLength = p.subParamsLength
	copy(np.subParamsIdx, p.subParamsIdx)
	np.rejectDigits = p.rejectDigits
	np.rejectSubDigits = p.rejectSubDigits
	np.digitIsSub = p.digitIsSub
	return np
}

// ToArray returns a mixed representation: each param as int32, followed by
// its sub-params as []int32 (if any).
func (p *Params) ToArray() []interface{} {
	res := make([]interface{}, 0, p.Length)
	for i := range p.Length {
		res = append(res, p.Params[i])
		start := int(p.subParamsIdx[i] >> 8)
		end := int(p.subParamsIdx[i] & 0xFF)
		if end-start > 0 {
			sub := make([]int32, end-start)
			copy(sub, p.subParams[start:end])
			res = append(res, sub)
		}
	}
	return res
}

// ParamsFromArray creates a Params from a mixed array representation.
// Elements can be int32 (params) or []int32 (sub-params for the preceding param).
// Leading sub-param arrays (before any int32) are skipped.
func ParamsFromArray(values []interface{}) *Params {
	p := DefaultParams()
	if len(values) == 0 {
		return p
	}
	startIdx := 0
	if _, ok := values[0].([]int32); ok {
		startIdx = 1
	}
	for i := startIdx; i < len(values); i++ {
		switch v := values[i].(type) {
		case int32:
			p.AddParam(v)
		case []int32:
			for _, sv := range v {
				p.AddSubParam(sv)
			}
		}
	}
	return p
}
