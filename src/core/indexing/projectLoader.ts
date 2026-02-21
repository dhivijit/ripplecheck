import { Project } from 'ts-morph';
import * as path from 'path';

export function loadProject(workspaceRootFsPath: string): Project {
    const tsConfigFilePath = path.join(workspaceRootFsPath, 'tsconfig.json');

    const project = new Project({
        tsConfigFilePath,
        skipAddingFilesFromTsConfig: false,
        skipFileDependencyResolution: false,
    });

    console.log(
        `[RippleCheck] Project loaded — ${project.getSourceFiles().length} source file(s) found`
    );

    return project;
}
