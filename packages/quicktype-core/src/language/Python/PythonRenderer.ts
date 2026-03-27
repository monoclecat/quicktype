import {
    arrayIntercalate,
    iterableFirst,
    mapSortBy,
    mapUpdateInto,
    setUnionInto,
} from "collection-utils";

import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer";
import { type Name, type Namer, funPrefixNamer } from "../../Naming";
import type { RenderContext } from "../../Renderer";
import type { OptionValues } from "../../RendererOptions";
import { type Sourcelike, modifySource } from "../../Source";
import { stringEscape } from "../../support/Strings";
import { defined, panic } from "../../support/Support";
import type { TargetLanguage } from "../../TargetLanguage";
import { followTargetType } from "../../Transformers";
import {
    type ClassProperty,
    ClassType,
    EnumType,
    type Type,
    UnionType,
} from "../../Type";
import {
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils";

import { forbiddenPropertyNames, forbiddenTypeNames } from "./constants";
import type { pythonOptions } from "./language";
import { classNameStyle, snakeNameStyle } from "./utils";

export class PythonRenderer extends ConvenienceRenderer {
    private readonly imports: Map<string, Set<string>> = new Map();

    private readonly declaredTypes: Set<Type> = new Set();

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        protected readonly pyOptions: OptionValues<typeof pythonOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        return forbiddenTypeNames;
    }

    protected forbiddenForObjectProperties(
        _: ClassType,
        _classNamed: Name,
    ): ForbiddenWordsInfo {
        return {
            names: forbiddenPropertyNames as unknown as string[],
            includeGlobalForbidden: false,
        };
    }

    protected makeNamedTypeNamer(): Namer {
        return funPrefixNamer("type", classNameStyle);
    }

    protected namerForObjectProperty(): Namer {
        return funPrefixNamer("property", (s) =>
            snakeNameStyle(s, false, this.pyOptions.nicePropertyNames),
        );
    }

    protected makeUnionMemberNamer(): null {
        return null;
    }

    protected makeEnumCaseNamer(): Namer {
        return funPrefixNamer("enum-case", (s) =>
            snakeNameStyle(s, true, this.pyOptions.nicePropertyNames),
        );
    }

    protected get commentLineStart(): string {
        return "# ";
    }

    protected emitDescriptionBlock(lines: Sourcelike[]): void {
        if (lines.length === 1) {
            const docstring = modifySource((content) => {
                if (content.endsWith('"')) {
                    return content.slice(0, -1) + '\\"';
                }

                return content;
            }, lines[0]);
            this.emitComments([
                { customLines: [docstring], lineStart: '"""', lineEnd: '"""' },
            ]);
        } else {
            this.emitCommentLines(lines, {
                firstLineStart: '"""',
                lineStart: "",
                afterComment: '"""',
            });
        }
    }

    protected get needsTypeDeclarationBeforeUse(): boolean {
        return true;
    }

    protected canBeForwardDeclared(t: Type): boolean {
        const kind = t.kind;
        return kind === "class" || kind === "enum";
    }

    protected emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line);
        this.indent(f);
    }

    protected string(s: string): Sourcelike {
        const openQuote = '"';
        return [openQuote, stringEscape(s), '"'];
    }

    protected withImport(module: string, name: string): Sourcelike {
        mapUpdateInto(this.imports, module, (s) =>
            s ? setUnionInto(s, [name]) : new Set([name]),
        );
        return name;
    }

    protected withTyping(name: string): Sourcelike {
        const builtins: Record<string, string> = {
            List: "list",
            Dict: "dict",
            Tuple: "tuple",
            Type: "type",
        };
        if (name in builtins) {
            return builtins[name];
        }

        return this.withImport("typing", name);
    }

    protected namedType(t: Type): Sourcelike {
        const name = this.nameForNamedType(t);
        if (this.declaredTypes.has(t)) return name;
        return ["'", name, "'"];
    }

    /**
     * Detect a discriminator property across union members.
     * Returns the property name if all members are ClassType and share a
     * property whose type is a single-case EnumType with distinct values.
     */
    protected findDiscriminator(
        members: ReadonlySet<Type>,
    ): string | undefined {
        const classMembers: ClassType[] = [];
        for (const m of members) {
            const actual = followTargetType(m);
            if (actual instanceof ClassType) {
                classMembers.push(actual);
            } else {
                return undefined;
            }
        }

        if (classMembers.length < 2) return undefined;

        const firstProps = classMembers[0].getProperties();
        for (const [propName] of firstProps) {
            let isDisc = true;
            const seenValues = new Set<string>();
            for (const cls of classMembers) {
                const p = cls.getProperties().get(propName);
                if (p === undefined) {
                    isDisc = false;
                    break;
                }

                const propType = followTargetType(p.type);
                if (
                    !(propType instanceof EnumType) ||
                    propType.cases.size !== 1
                ) {
                    isDisc = false;
                    break;
                }

                const val = defined(iterableFirst(propType.cases));
                if (seenValues.has(val)) {
                    isDisc = false;
                    break;
                }

                seenValues.add(val);
            }

            if (isDisc && seenValues.size === classMembers.length) {
                return propName;
            }
        }

        return undefined;
    }

    /**
     * For a discriminated union, return the (constValue, memberType) pairs.
     */
    protected getDiscriminatorEntries(
        members: ReadonlySet<Type>,
        discField: string,
    ): Array<[string, Type]> {
        const result: Array<[string, Type]> = [];
        for (const m of members) {
            const cls = followTargetType(m) as ClassType;
            const prop = defined(cls.getProperties().get(discField));
            const enumT = followTargetType(prop.type) as EnumType;
            result.push([defined(iterableFirst(enumT.cases)), m]);
        }

        return result;
    }

    protected pythonType(t: Type, _isRootTypeDef = false): Sourcelike {
        const actualType = followTargetType(t);

        return matchType<Sourcelike>(
            actualType,
            (_anyType) => this.withTyping("Any"),
            (_nullType) => "None",
            (_boolType) => "bool",
            (_integerType) => "int",
            (_doubletype) => "float",
            (_stringType) => "str",
            (arrayType) => [
                this.withTyping("List"),
                "[",
                this.pythonType(arrayType.items),
                "]",
            ],
            (classType) => this.namedType(classType),
            (mapType) => [
                this.withTyping("Dict"),
                "[str, ",
                this.pythonType(mapType.values),
                "]",
            ],
            (enumType) => {
                if (enumType.cases.size === 1) {
                    const value = defined(iterableFirst(enumType.cases));
                    this.withImport("typing", "Literal");
                    return ["Literal[", this.string(value), "]"];
                }

                return this.namedType(enumType);
            },
            (unionType) => {
                const [hasNull, nonNulls] = removeNullFromUnion(unionType);
                const memberTypes = Array.from(nonNulls).map((m) =>
                    this.pythonType(m),
                );

                // Build the base union expression
                let unionExpr: Sourcelike;
                if (this.pyOptions.features.unionSyntax) {
                    unionExpr = arrayIntercalate(" | ", memberTypes);
                } else if (nonNulls.size > 1) {
                    unionExpr = [
                        this.withTyping("Union"),
                        "[",
                        arrayIntercalate(", ", memberTypes),
                        "]",
                    ];
                } else {
                    unionExpr = defined(iterableFirst(memberTypes));
                }

                // Wrap with discriminator annotation for pydantic mode
                const discField = this.findDiscriminator(nonNulls);
                if (
                    discField !== undefined &&
                    this.pyOptions.pydanticBaseModel
                ) {
                    this.withImport("typing", "Annotated");
                    this.withImport("pydantic", "Field");
                    unionExpr = [
                        "Annotated[",
                        unionExpr,
                        ", ",
                        "Field(discriminator=",
                        this.string(discField),
                        ")]",
                    ];
                }

                if (hasNull !== null) {
                    const rest: string[] = [];
                    if (
                        !this.getAlphabetizeProperties() &&
                        _isRootTypeDef
                    ) {
                        rest.push(" = None");
                    }

                    if (this.pyOptions.features.unionSyntax) {
                        return [unionExpr, " | None", ...rest];
                    }

                    return [
                        this.withTyping("Optional"),
                        "[",
                        unionExpr,
                        "]",
                        ...rest,
                    ];
                }

                return [unionExpr];
            },
            (transformedStringType) => {
                if (transformedStringType.kind === "date-time") {
                    return this.withImport("datetime", "datetime");
                }

                if (transformedStringType.kind === "uuid") {
                    return this.withImport("uuid", "UUID");
                }

                return panic(
                    `Transformed type ${transformedStringType.kind} not supported`,
                );
            },
        );
    }

    protected declarationLine(t: Type): Sourcelike {
        if (t instanceof ClassType) {
            if (this.pyOptions.pydanticBaseModel) {
                return [
                    "class ",
                    this.nameForNamedType(t),
                    "(",
                    this.withImport("pydantic", "BaseModel"),
                    "):",
                ];
            }
            return ["class ", this.nameForNamedType(t), ":"];
        }

        if (t instanceof EnumType) {
            return [
                "class ",
                this.nameForNamedType(t),
                "(",
                this.withImport("enum", "Enum"),
                "):",
            ];
        }

        return panic(`Can't declare type ${t.kind}`);
    }

    protected declareType<T extends Type>(t: T, emitter: () => void): void {
        this.emitBlock(this.declarationLine(t), () => {
            this.emitDescription(this.descriptionForType(t));
            emitter();
        });
        this.declaredTypes.add(t);
    }

    protected emitClassMembers(_t: ClassType): void {
        if (!this.pyOptions.pydanticBaseModel) return;
    }

    protected typeHint(...sl: Sourcelike[]): Sourcelike {
        return sl;
    }

    protected typingDecl(name: Sourcelike, type: string): Sourcelike {
        return [name, this.typeHint(": ", this.withTyping(type))];
    }

    protected typingReturn(type: string): Sourcelike {
        return this.typeHint(" -> ", this.withTyping(type));
    }

    protected sortClassProperties(
        properties: ReadonlyMap<string, ClassProperty>,
        _propertyNames: ReadonlyMap<string, Name>,
    ): ReadonlyMap<string, ClassProperty> {
        return mapSortBy(properties, (p: ClassProperty) => {
            return (p.type instanceof UnionType &&
                nullableFromUnion(p.type) != null) ||
                p.isOptional
                ? 1
                : 0;
        });
    }

    protected emitClass(t: ClassType): void {
        if (!this.pyOptions.pydanticBaseModel) {
            this.emitLine("@", this.withImport("dataclasses", "dataclass"));
        }

        this.declareType(t, () => {
            if (t.getProperties().size === 0) {
                this.emitLine("pass");
            } else {
                this.forEachClassProperty(
                    t,
                    "none",
                    (name, jsonName, cp) => {
                        this.emitLine(
                            name,
                            this.typeHint(
                                ": ",
                                this.pythonType(cp.type, true),
                            ),
                        );
                        this.emitDescription(
                            this.descriptionForClassProperty(t, jsonName),
                        );
                    },
                );
            }

            this.ensureBlankLine();
            this.emitClassMembers(t);
        });
    }

    protected emitEnum(t: EnumType): void {
        this.declareType(t, () => {
            this.forEachEnumCase(t, "none", (name, jsonName) => {
                this.emitLine([name, " = ", this.string(jsonName)]);
            });
        });
    }

    protected emitImports(): void {
        this.imports.forEach((names, module) => {
            this.emitLine(
                "from ",
                module,
                " import ",
                Array.from(names).join(", "),
            );
        });
    }

    protected emitSupportCode(): void {
        return;
    }

    protected emitClosingCode(): void {
        return;
    }

    protected emitSourceStructure(_givenOutputFilename: string): void {
        const declarationLines = this.gatherSource(() => {
            this.forEachNamedType(
                ["interposing", 2],
                (c: ClassType) => this.emitClass(c),
                (e) => {
                    if (e.cases.size === 1) return;
                    this.emitEnum(e);
                },
                (_u) => {
                    return;
                },
            );
        });

        const closingLines = this.gatherSource(() => this.emitClosingCode());
        const supportLines = this.gatherSource(() => this.emitSupportCode());

        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        }

        this.ensureBlankLine();
        this.emitImports();
        this.ensureBlankLine(2);
        this.emitGatheredSource(supportLines);
        this.ensureBlankLine(2);
        this.emitGatheredSource(declarationLines);
        this.ensureBlankLine(2);
        this.emitGatheredSource(closingLines);
    }
}
