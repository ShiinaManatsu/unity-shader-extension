// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { unlink, stat, writeFile, existsSync, writeFileSync } from 'node:fs';

class ASTNode {
	name: string = "";
	type: string = "";
	text: string = "";
	attr: string = "";
	dataType: string = "";
	nodes: ASTNode[] = [];
};

const varDecl: string = "VarDecl";
const functionDecl: string = "FunctionDecl";
const hlslNumThreadsAttr: string = "HLSLNumThreadsAttr";

function recursiveASTNode(text: [number, string][]): ASTNode {
	let grouped: [number, string][] = [];
	let indent = text[0][0];
	let node = new ASTNode();
	let mark = -1;

	for (let i = 0; i < text.length; i++) {
		let line = text[i];
		let currentIndent = line[0];

		if (i === 0) {
			node.text = line[1];
			node.type = node.text.substring(0, node.text.indexOf(' '));

			if (node.type === varDecl) {
				let striped = node.text.replace(" invalid", "").replace(" used", "").substring(node.text.indexOf(">") + 2, node.text.length);
				striped = striped.substring(striped.indexOf(" ") + 1, striped.length);
				striped = striped.substring(0, striped.indexOf(" "));
				node.name = striped;
				node.dataType = node.text.substring(node.text.indexOf(node.name) + node.name.length + 2, node.text.length);
				node.dataType = node.dataType.substring(0, node.dataType.indexOf("'"));
				let splited = node.dataType.split(" ");
				node.dataType = splited[splited.length - 1];
			}

			if (node.type === functionDecl) {
				let striped = node.text.replace(" implicit", "").replace(" used", "").substring(node.text.indexOf(">") + 2, node.text.length);
				striped = striped.substring(striped.indexOf(" ") + 1, striped.length);
				striped = striped.substring(0, striped.indexOf(" "));
				node.name = striped;
			}

			continue;
		}
		if (currentIndent > indent) {

			if (currentIndent === mark) {
				node.nodes.push(recursiveASTNode(grouped));
				grouped = [];
				mark = -1;
			}
			if (mark === -1) {
				mark = currentIndent;
			}
			grouped.push(line);
		}
	}

	if (grouped.length > 0) {
		node.nodes.push(recursiveASTNode(grouped));
	}

	return node;
}

function generateASTTree(text: string): ASTNode {
	const regex = new RegExp("^(\\||-|\\s|`)*", "g");

	let lines = text.split('\n');

	let lineWithIndent: [number, string][] = [];

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		let indent = [...line.matchAll(regex)][0][0].length / 2;
		lineWithIndent.push([indent, line.substring(indent * 2, line.length)]);
	}

	return recursiveASTNode(lineWithIndent);
}

function getVariableAndKernelNodeFromASTTree(node: ASTNode): [ASTNode[], ASTNode[]] {
	var vars = node.nodes.filter((v, _, __) => v.type === varDecl);
	var kernels = node.nodes.filter((v, _, __) =>
		v.type === functionDecl &&
		!v.text.includes("invalid sloc") &&
		v.nodes.filter((v, _, __) => v.type === hlslNumThreadsAttr).length !== 0);

	return [vars, kernels];
}

function fillCSharpCode(className: string, variables: string[], kernels: string[]): string {
	let csVariables = variables.map(x => `		public static int ${x};`).join("\n");
	let csKernels = kernels.map(x => `		public static int ${x} { get; set; }`).join("\n\n");
	return `using UnityEngine;

namespace ComputeShaderReferences
{
	public static class ${className}
	{
${csVariables}

${csKernels}

		public static void Setup(ComputeShader cs)
		{
			foreach (var info in typeof(${className}).GetFields())
			{
				var index = Shader.PropertyToID(info.Name);
				info.SetValue(null, index);
			}
			foreach (var info in typeof(${className}).GetProperties())
			{
				try
				{
					var index = cs.FindKernel(info.Name);
					info.SetValue(null, index);
				}
				catch
				{
					continue;
				}
			}
		}
	}
}`;
}

let extensionPath = "";

async function dxCompile(filePath: string, profile: string, workingPath?: string, includes?: string[]): Promise<ASTNode> {
	let exe = `\"${extensionPath}/dxcompiler/dxc.exe\"`;
	let include = ``;
	if (includes && includes.length !== 0) {
		include = ` -I ${includes.map(x => `\"${x}\"`).join(" ")}`;
	}

	let p = `-T ${profile}_6_0${include} -ast-dump \"${filePath}\"`;

	return new Promise((resolve, _) => {
		exec(`${exe} ${p}`, { cwd: workingPath, maxBuffer: 1024 * 1024 * 5 }, (_, stdout, __) => {
			resolve(generateASTTree(stdout));
		});
	});
}

function getMatchedWordsCount(textToMatch: string, pattern: string[]): number {
	return pattern.filter(x => textToMatch.includes(x)).length;
}

function mapPropertyType(type: string): [string, string] {
	type = type.replace("half", "float").replace("fixed", "float");

	//	match, type in property block, default value
	let matchTypes: Array<[string[], string, string]> = [];

	matchTypes.push([["int", "uint"], `Integer`, `1`]);
	matchTypes.push([["float", "double"], `Float`, `1`]);
	matchTypes.push([["sampler", "sampler2D", "Texture2D"], `2D`, `"white" {}`]);
	matchTypes.push([["Texture2DArray"], `2DArray`, `"" {}`]);
	matchTypes.push([["sampler2D", "Texture3D"], `3D`, `"" {}`]);
	matchTypes.push([["samplerCUBE", "TextureCube"], `Cube`, `"" {}`]);
	matchTypes.push([["TextureCubeArray"], `CubeArray`, `"" {}`]);
	matchTypes.push([["float2", "float3", "float4"], `Vector`, `(1, 1, 1, 1)`]);

	for (let i = 0; i < matchTypes.length; i++) {
		let match = matchTypes[i];
		if (match[0].includes(type)) {
			return [match[1], match[2]];
		}
	}
	return [" ", " "];
}

function getPropertyBlock(indexStart: number, text: string): string {
	let regex = /{\W*}/gim;
	let match = [...text.matchAll(regex)].map(x => x[0]);
	match.forEach(x => {
		text = text.replace(x, "");
	});
	let indexOfRightBracket = text.indexOf("}", indexStart + 2);
	return text.substring(indexStart, indexOfRightBracket);
}

function insertVariableToProperty(name: string, type: string, text: string, activeTextEditor: vscode.TextEditor) {
	let propertyBlockExist = isPropertyBlockExist(text);

	let insertLineNumber = 0;
	if (propertyBlockExist) {
	}

	if (propertyBlockExist) {
		let indexOfProperties = text.indexOf("Properties");
		let indexOfLeftBracket = text.indexOf("{", indexOfProperties);


		if (propertyBlockExist && isPropertyExist(name, getPropertyBlock(indexOfLeftBracket, text))) {
			vscode.window.showInformationMessage(`Looks like variable ${name} has been defined in properties`);
			return;
		}
		let blockSameLineWithProperties = text.substring(indexOfProperties, indexOfLeftBracket + 1).includes("\n");
		let lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			if (line.includes("Properties")) {
				insertLineNumber = i;
				break;
			}
		}
		insertLineNumber++;
		if (!blockSameLineWithProperties) { insertLineNumber++; }
	}
	else {
		let shaderSubshaderReg = /(Shader)(.|\n)*(SubShader)/gim;
		let shaderHeaderReg = /(Shader)\W*".*"\W*{/gim;
		
		let match = shaderSubshaderReg.exec(text);
		if (match !== null) {
			insertLineNumber = match.index;
		}
		else {
			match = shaderHeaderReg.exec(text);
			if (match !== null) {
				insertLineNumber = match.index;
			}
		}
	}
	let map = mapPropertyType(type);

	let namePlaceholder = `$\{1:${name}}`;
	let propertyPlaceholder = `$\{2:${name}}`;
	let typePlaceholder = `$\{3:${map[0]}}`;
	let defaultValuePlaceholder = `$\{4:${map[1]}}`;

	let snippetString = `\n${namePlaceholder}("${propertyPlaceholder}", ${typePlaceholder}) = ${defaultValuePlaceholder}`;
	activeTextEditor.insertSnippet(new vscode.SnippetString(snippetString), new vscode.Position(insertLineNumber - 2, snippetString.length));
}

function isPropertyBlockExist(text: string): boolean {
	return text.match(/\{\W*Properties\W*{/gm) !== null;
}

function isPropertyExist(name: string, text: string): boolean {
	let regex = new RegExp(`(${name})\\W*\\(`, "gim");
	return text.match(regex) !== null;
}

async function addVariableToPropertiesPlainText() {
	let activeTextEditor = vscode.window.activeTextEditor;
	if (!activeTextEditor) { return; }
	let filePath = activeTextEditor.document?.uri?.fsPath;
	if (!filePath) { return; }

	let lineCode = activeTextEditor.selection.active.line;
	if (!lineCode) { return; }
	lineCode++;

	let line = activeTextEditor.document.lineAt(lineCode - 1);
	if (!line || typeof (line) === undefined) { return; }

	let text = line.text;
	if (text.includes("//")) { text = text.substring(0, text.indexOf("//")); }
	if (text.includes("=")) { text = `${text.substring(0, text.indexOf("="))};`; }
	text = text.trim();
	text = text.replace(";", "");

	const regex = new RegExp("\\w*", "g");

	let match = [...text.matchAll(regex)].map(x => x[0]).filter(x => x.length > 0).reverse();

	if (match.length < 2) { return; }
	let name = match[0];
	let type = match[1];

	insertVariableToProperty(name, type, text, activeTextEditor);
}

async function addVariableToPropertiesAST(): Promise<boolean> {
	let activeTextEditor = vscode.window.activeTextEditor;
	if (!activeTextEditor) { return false; }
	let filePath = activeTextEditor.document?.uri?.fsPath;
	if (!filePath) { return false; }

	let lineCode = activeTextEditor.selection.active.line;
	if (!lineCode) { return false; }
	lineCode++;

	let text = activeTextEditor.document.getText();
	let line = activeTextEditor.document.lineAt(lineCode - 1);
	if (!text) { return false; }
	if (!line || typeof (line) === undefined) { return false; }
	let indexOfLine = text?.indexOf(line.text);
	let indexOfCGPROGRAM = text.substring(0, indexOfLine).lastIndexOf("CGPROGRAM");
	let indexOfENDCG = text.substring(indexOfLine, text.length).indexOf("ENDCG") + indexOfLine;

	let shaderBody = text.substring(indexOfCGPROGRAM + 11, indexOfENDCG);

	let tempFilePath = `${extensionPath}\\temp.hlsl`;
	let lineIndexInShaderBody = shaderBody.indexOf(line.text) + line.text.length;
	lineIndexInShaderBody = shaderBody.substring(0, lineIndexInShaderBody).split('\n').length;
	writeFileSync(tempFilePath, shaderBody);
	let includes: string[] = [];
	if (vscode.workspace.workspaceFolders !== undefined) {
		let worksapce = vscode.workspace.workspaceFolders[0].uri.fsPath;
		includes.push(worksapce);
	}

	let node = await dxCompile(tempFilePath, "ps", undefined, includes);
	if (existsSync(tempFilePath)) { unlink(tempFilePath, () => { }); }
	let matchCount = 0;
	let matchLineText = `<line:${lineIndexInShaderBody}`;
	let varible = node.nodes
		.filter(x => x.type === varDecl)
		.filter(x => x.text.includes(matchLineText))
		.sort((a, b) => {
			let aMatch = getMatchedWordsCount(a.text, line!.text.split(" "));
			let bMatch = getMatchedWordsCount(b.text, line!.text.split(" "));
			matchCount = Math.max(matchCount, aMatch, bMatch);
			return aMatch > bMatch ? 1 : -1;
		});
	if (!varible || varible.length === 0 || (matchCount === 0 && varible.length > 1)) {
		// vscode.window.showInformationMessage("Variable not used or there is compile error.");
		return false;
	}
	let selectedVarible = varible[0];



	insertVariableToProperty(selectedVarible.name, selectedVarible.dataType, text, activeTextEditor);
	// vscode.window.showInformationMessage(varible[0].dataType);
	return true;
}

async function addVariableToProperties() {
	let ret = await addVariableToPropertiesAST();
	if (!ret) {
		addVariableToPropertiesPlainText();
	}
}

async function generateHLSLVariables() {
	let filePath = vscode.window.activeTextEditor?.document?.uri?.fsPath;
	let realWorkingPath = extensionPath;
	if (!filePath) { return; }
	let realFilePath = filePath;

	// In worksapce
	if (vscode.workspace.workspaceFolders !== undefined) {
		realWorkingPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
		realFilePath = filePath.replace(`${realWorkingPath}\\`, "");
	}

	let node = await dxCompile(realFilePath, "cs", realWorkingPath);
	let ast = getVariableAndKernelNodeFromASTTree(node);
	let cs = fillCSharpCode(realFilePath.replace(/^.*[\\\/]/, '').split(".")[0], ast[0].map(x => x.name), ast[1].map(x => x.name));
	let csPath = `${filePath.substring(0, filePath.lastIndexOf('.'))}.cs`;
	writeFile(csPath, cs, () => { });
}

export function activate(context: vscode.ExtensionContext) {
	extensionPath = context.extensionPath;
	let register: vscode.Disposable[] = [];

	register.push(vscode.commands.registerCommand('unity-shader-extension.Unity Shader: Generate CSharp References', generateHLSLVariables));
	register.push(vscode.commands.registerCommand('unity-shader-extension.Add To Property', addVariableToProperties));

	register.forEach(x => context.subscriptions.push(x));
}

export function deactivate() { }