pnpm install
pnpm ui:build
pnpm build

pnpm openclaw onboard --install-daemon

pnpm openclaw gateway --port 18789 --verbose

# 同步官方代码：

# 1. 克隆你 Fork 的仓库（替换为你的仓库地址）

git clone https://github.com/你的用户名/目标仓库.git
cd 目标仓库
（就是到自己的项目目录）

# 2. 关联上游原仓库（替换为原作者的仓库地址）

git remote add upstream https://github.com/原作者用户名/目标仓库.git

# 3. 拉取上游仓库的最新代码

git fetch upstream

# 1. 切换到冲突的分支（比如 main）

git checkout main

# 2. 合并上游最新代码到本地分支

git merge upstream/main

# 3. 此时 Git 会提示冲突文件，执行以下命令查看冲突文件

git status

# 输出中会显示 "both modified: 文件名"，这些就是冲突文件

# 4. 打开冲突文件，手动解决冲突

# 冲突文件中会有类似标记：

# <<<<<<< HEAD （你的代码）

# 你的修改内容

# =======

# 上游仓库的修改内容

# >>>>>>> upstream/main

# 手动删除标记，保留需要的代码，保存文件

# 5. 解决所有冲突后，标记文件为已解决

git add .

# 6. 完成合并提交

git commit -m "解决冲突，同步上游仓库最新代码"

# 7. 推送到你 Fork 的远程仓库（同步到 GitHub）

git push origin main
