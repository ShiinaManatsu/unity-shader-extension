// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { writeFile } from 'node:fs';

class ASTNode {
	name: string = "";
	type: string = "";
	text: string = "";
	attr: string = "";
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
				let striped = node.text.replace(" used", "").substring(node.text.indexOf(">") + 2, node.text.length);
				striped = striped.substring(striped.indexOf(" ") + 1, striped.length);
				striped = striped.substring(0, striped.indexOf(" "));
				node.name = striped;
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

async function dxCompile(filePath: string, workingPath: string): Promise<ASTNode> {
	let exe = `\"${extensionPath}/dxcompiler/dxc.exe\"`;
	let p = `-T cs_6_0 -ast-dump \"${filePath}\"`;

	// var include = `Packages/`;
	// var p = `-T cs_6_0 -E AllocateIndexForObejct -I ${include} -ast-dump ${filePath}`;

	return new Promise((resolve, _) => {
		exec(`${exe} ${p}`, { cwd: workingPath, maxBuffer: 1024 * 1024 * 5 }, (_, stdout, __) => {
			resolve(generateASTTree(stdout));
		});
	});
}

async function addVariableToProperties() {
	let filePath = vscode.window.activeTextEditor?.document?.uri?.fsPath;
	if (!filePath) { return; }

	let lineCode = vscode.window.activeTextEditor?.selection.active.line;
	if (!lineCode) { return; }
	lineCode++;

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

	let node = await dxCompile(realFilePath, realWorkingPath);
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