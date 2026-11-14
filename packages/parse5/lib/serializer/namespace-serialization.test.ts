import { it, assert, describe } from 'vitest';
import { html, parse, parseFragment, serialize, serializeOuter, type Token, type TreeAdapter } from 'parse5';
import { generateTestsForEachTreeAdapter, treeAdapters } from 'parse5-test-utils/utils/common.js';

const { NS } = html;

/**
 * 行为锁定矩阵：serializer 中 `serializeAttributes` 的命名空间序列化分支。
 *
 * 背景：含命名空间的接口报文归档产物走 `attr.namespace` 分支，该分支此前没有
 * 被既有用例完整触达（覆盖率显示 NS.XML 分支与 default 自定义前缀兜底分支从未
 * 命中）。本矩阵只锁定当前真实行为，不修正任何与规范不符之处。
 *
 * 分支形态（packages/parse5/lib/serializer/index.ts serializeAttributes）：
 * - 无 namespace：原样输出 `name="value"`
 * - NS.XML：输出 `xml:name="value"`
 * - NS.XMLNS：name === 'xmlns' 时不加前缀，否则输出 `xmlns:name="value"`
 * - NS.XLINK：输出 `xlink:name="value"`
 * - default（其它未知 namespace，自定义前缀兜底）：输出 `${prefix}:name="value"`
 */
describe('serializer - namespace attribute serialization (behavior lock)', () => {
    /**
     * 解析器驱动的三类标准前缀形态 + 无名空间兜底形态。
     * 每条用例锁定：属性的 namespace/prefix 归属、outer 与 inner 序列化产物。
     *
     * 注意（现状，保持原样）：解析器的 XML_ATTRS_ADJUSTMENT_MAP 只映射
     * xml:lang/xml:space，因此 xml:base 不会获得 NS.XML，而是以无名空间属性
     * `xml:base` 原样输出——它走的是无 namespace 分支，输出恰好与带前缀一致。
     */
    const parserDrivenCases: {
        name: string;
        input: string;
        tag: string;
        expectedOuter: string;
        expectedAttrs: Pick<Token.Attribute, 'name' | 'prefix' | 'namespace'>[];
    }[] = [
        {
            name: 'NS.XML standard prefix (xml:lang / xml:space)',
            input: '<svg xml:lang="en" xml:space="preserve"></svg>',
            tag: 'svg',
            expectedOuter: '<svg xml:lang="en" xml:space="preserve"></svg>',
            expectedAttrs: [
                { name: 'lang', prefix: 'xml', namespace: NS.XML },
                { name: 'space', prefix: 'xml', namespace: NS.XML },
            ],
        },
        {
            name: 'no-namespace fallback for unmapped xml-prefixed name (xml:base)',
            input: '<svg xml:base="http://example.org"></svg>',
            tag: 'svg',
            expectedOuter: '<svg xml:base="http://example.org"></svg>',
            expectedAttrs: [{ name: 'xml:base', prefix: undefined, namespace: undefined }],
        },
        {
            name: 'NS.XMLNS plain declaration (xmlns) and prefixed declaration (xmlns:xlink)',
            input: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>',
            tag: 'svg',
            expectedOuter: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>',
            expectedAttrs: [
                { name: 'xmlns', prefix: '', namespace: NS.XMLNS },
                { name: 'xlink', prefix: 'xmlns', namespace: NS.XMLNS },
            ],
        },
        {
            name: 'NS.XLINK standard prefix (xlink:*)',
            input: '<svg xlink:href="foo" xlink:title="t"></svg>',
            tag: 'svg',
            expectedOuter: '<svg xlink:href="foo" xlink:title="t"></svg>',
            expectedAttrs: [
                { name: 'href', prefix: 'xlink', namespace: NS.XLINK },
                { name: 'title', prefix: 'xlink', namespace: NS.XLINK },
            ],
        },
        {
            name: 'plain HTML attribute without namespace',
            input: '<div data-x="1"></div>',
            tag: 'div',
            expectedOuter: '<div data-x="1"></div>',
            expectedAttrs: [{ name: 'data-x', prefix: undefined, namespace: undefined }],
        },
    ];

    function findElementByTag(adapter: TreeAdapter, node: never, tag: string): never {
        for (const child of adapter.getChildNodes(node) ?? []) {
            if (adapter.isElementNode(child)) {
                if (adapter.getTagName(child) === tag) {
                    return child;
                }
                const nested = findElementByTag(adapter, child, tag);
                if (nested) {
                    return nested;
                }
            }
        }
        return null as never;
    }

    generateTestsForEachTreeAdapter('namespace parser-driven forms', (treeAdapter) => {
        for (const testCase of parserDrivenCases) {
            describe(testCase.name, () => {
                it('assigns the expected attribute namespace/prefix and serializes outer/inner forms', () => {
                    const fragment = parseFragment(testCase.input, { treeAdapter });
                    const element = findElementByTag(treeAdapter, fragment as never, testCase.tag);

                    assert.ok(element, `expected to find <${testCase.tag}> element`);

                    const actualAttrs = treeAdapter.getAttrList(element).map((attr) => ({
                        name: attr.name,
                        prefix: attr.prefix,
                        namespace: attr.namespace,
                    }));
                    assert.deepEqual(actualAttrs, testCase.expectedAttrs);

                    assert.equal(serializeOuter(element, { treeAdapter }), testCase.expectedOuter);
                    // 无子元素时 inner 序列化是空字符串，锁定该组合行为。
                    assert.equal(serialize(element, { treeAdapter }), '');
                });

                // 矩阵乘位置信息开关：序列化不消费 sourceCodeLocation，两种开关下产物必须逐字一致。
                it.each([false, true])('is unaffected by sourceCodeLocationInfo=%s', (locationInfo) => {
                    const document = parse(testCase.input, {
                        treeAdapter,
                        sourceCodeLocationInfo: locationInfo,
                    });
                    const element = findElementByTag(treeAdapter, document as never, testCase.tag);

                    if (locationInfo) {
                        assert.ok(treeAdapter.getNodeSourceCodeLocation(element));
                    }

                    const withoutLocation = parse(testCase.input, {
                        treeAdapter,
                        sourceCodeLocationInfo: false,
                    });
                    const elementWithoutLocation = findElementByTag(
                        treeAdapter,
                        withoutLocation as never,
                        testCase.tag,
                    );

                    assert.equal(
                        serializeOuter(element, { treeAdapter }),
                        serializeOuter(elementWithoutLocation, { treeAdapter }),
                    );
                    assert.equal(serializeOuter(element, { treeAdapter }), testCase.expectedOuter);
                });

                // 矩阵乘重复序列化：对同一棵树重复序列化必须幂等。
                it('is idempotent across repeated serializations', () => {
                    const fragment = parseFragment(testCase.input, { treeAdapter });
                    const element = findElementByTag(treeAdapter, fragment as never, testCase.tag);

                    const first = serializeOuter(element, { treeAdapter });
                    const second = serializeOuter(element, { treeAdapter });
                    const third = serialize(fragment, { treeAdapter });
                    const fourth = serialize(fragment, { treeAdapter });

                    assert.equal(second, first);
                    assert.equal(fourth, third);
                    assert.equal(first, testCase.expectedOuter);
                });
            });
        }
    });

    /**
     * default 自定义前缀兜底分支：解析器自身不会产出 XML/XMLNS/XLINK 之外的
     * attribute namespace，因此用手工构造的 AST 直接触达该分支。
     *
     * 与规范不符的现状（如实锁定，不修正）：
     * - prefix 为 undefined 时，模板字符串产出字面量 `undefined:bar`；
     * - prefix 为空串时产出以冒号开头的 `:baz`（非法 XML 名称）。
     */
    describe('default fallback branch with custom attribute namespace', () => {
        const CUSTOM_NS = 'http://example.com/custom-namespace';
        const CUSTOM_ATTRS: Token.Attribute[] = [
            { name: 'foo', namespace: CUSTOM_NS, prefix: 'cust', value: 'v' },
            { name: 'bar', namespace: CUSTOM_NS, prefix: undefined, value: 'w' },
            { name: 'baz', namespace: CUSTOM_NS, prefix: '', value: 'z' },
        ];
        const EXPECTED_OUTER = '<custom cust:foo="v" undefined:bar="w" :baz="z"></custom>';

        generateTestsForEachTreeAdapter('custom-prefix fallback', (treeAdapter) => {
            it.each([NS.HTML, NS.SVG])(
                'serializes prefix/name verbatim for element in namespace %s',
                (elementNamespace) => {
                    const element = treeAdapter.createElement(
                        'custom',
                        elementNamespace,
                        CUSTOM_ATTRS.map((attr) => ({ ...attr })),
                    );

                    assert.equal(serializeOuter(element, { treeAdapter }), EXPECTED_OUTER);
                },
            );

            it('is unaffected by the sourceCodeLocationInfo switch', () => {
                // 手工构造的 AST 本就没有 sourceCodeLocation；序列化器不消费位置信息，
                // 这里锁定该组合下 outer/inner 产物保持稳定。
                const element = treeAdapter.createElement(
                    'custom',
                    NS.SVG,
                    CUSTOM_ATTRS.map((attr) => ({ ...attr })),
                );

                assert.equal(serializeOuter(element, { treeAdapter }), EXPECTED_OUTER);
                assert.equal(serialize(element, { treeAdapter }), '');
            });

            it('is idempotent across repeated serializations', () => {
                const element = treeAdapter.createElement(
                    'custom',
                    NS.SVG,
                    CUSTOM_ATTRS.map((attr) => ({ ...attr })),
                );

                const first = serializeOuter(element, { treeAdapter });
                const second = serializeOuter(element, { treeAdapter });

                assert.equal(second, first);
                assert.equal(first, EXPECTED_OUTER);
            });

            // 与规范不符的现状：文本 round-trip 稳定，但重新解析后自定义 namespace 语义丢失，
            // 属性退化为无名空间属性（解析器不识别 cust: 前缀）。
            it('keeps textual output stable on round-trip while losing namespace semantics', () => {
                const element = treeAdapter.createElement(
                    'custom',
                    NS.HTML,
                    CUSTOM_ATTRS.map((attr) => ({ ...attr })),
                );
                const serialized = serializeOuter(element, { treeAdapter });
                const reparsed = parseFragment(serialized, { treeAdapter });
                const reparsedElement = treeAdapter.getChildNodes(reparsed)[0];

                assert.equal(serializeOuter(reparsedElement, { treeAdapter }), serialized);
                for (const attr of treeAdapter.getAttrList(reparsedElement)) {
                    assert.isUndefined(attr.namespace);
                    assert.isUndefined(attr.prefix);
                }
                assert.deepEqual(
                    treeAdapter.getAttrList(reparsedElement).map((attr) => attr.name),
                    ['cust:foo', 'undefined:bar', ':baz'],
                );
            });
        });
    });

    /**
     * 跨适配器一致性：default 与 htmlparser2 两套 tree adapter 对同一报文的
     * 命名空间序列化产物必须逐字相同（归档产物不依赖所选 tree adapter）。
     */
    it('produces identical output across tree adapters', () => {
        const cases = parserDrivenCases.map((testCase) => testCase.input);

        for (const input of cases) {
            const defaultFragment = parseFragment(input, { treeAdapter: treeAdapters.default });
            const htmlparser2Fragment = parseFragment(input, { treeAdapter: treeAdapters.htmlparser2 });

            assert.equal(
                serialize(defaultFragment, { treeAdapter: treeAdapters.default }),
                serialize(htmlparser2Fragment, { treeAdapter: treeAdapters.htmlparser2 }),
            );
        }
    });
});
