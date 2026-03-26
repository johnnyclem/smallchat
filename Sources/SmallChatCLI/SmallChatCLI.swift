import ArgumentParser

@main
struct SmallChatCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "smallchat",
        abstract: "A message-passing tool compiler inspired by the Smalltalk/Objective-C runtime",
        version: "0.2.0",
        subcommands: [
            CompileCommand.self,
            ServeCommand.self,
            ChannelCommand.self,
            ResolveCommand.self,
            InspectCommand.self,
            InitCommand.self,
            ReplCommand.self,
            DocsCommand.self,
            DoctorCommand.self,
        ]
    )
}
