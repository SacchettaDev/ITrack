namespace ITrack.api.Services;

public class SerpApiOptions
{
    public const string SectionName = "SerpApi";

    public string BaseUrl { get; set; } = "https://serpapi.com/search.json";
    public string ApiKey { get; set; } = "";
    public int ResultsLimit { get; set; } = 20;
}

